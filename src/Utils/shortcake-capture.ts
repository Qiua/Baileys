import { appendFileSync, writeFileSync } from 'fs'
import type { BinaryNode } from '../WABinary'
import type { ILogger } from './logger'

type Direction = 'recv' | 'send'

/**
 * Minimal structural shape of a Baileys socket that the capture helper needs.
 * Kept structural (instead of importing the socket type) to avoid an import cycle.
 */
type CaptureSocket = {
	ws: {
		on(event: string, listener: (...args: any[]) => void): void
		off(event: string, listener: (...args: any[]) => void): void
	}
}

export type ShortcakeCaptureOptions = {
	/** file to (over)write and append the captured ceremony to. Default: './shortcake-capture.log' */
	filePath?: string
	/** optional logger to print a one-line notice per captured node */
	logger?: ILogger
	/**
	 * Override which nodes are captured. By default anything mentioning
	 * passkey / shortcake / prologue, plus the pairing nodes that bracket the
	 * ceremony (pair-device, pair-success, link_code_companion, companion...).
	 */
	matcher?: (node: BinaryNode, direction: Direction) => boolean
	/** extra keywords to match on, merged with the defaults */
	extraKeywords?: string[]
}

export type ShortcakeCaptureHandle = {
	/** stop capturing and detach the listeners */
	stop: () => void
	/** the file the capture is written to */
	filePath: string
	/** how many nodes have been captured so far */
	count: () => number
}

const DEFAULT_KEYWORDS = [
	'passkey',
	'shortcake',
	'prologue',
	'webauthn',
	'pair-device',
	'pair-success',
	'link_code_companion',
	'companion_hello',
	'companion_finish',
	'companion'
]

/** true if the node (or any descendant) mentions one of the keywords in its tag/attrs */
const nodeMentions = (node: BinaryNode, keywords: string[]): boolean => {
	const haystack: string[] = [node.tag]
	for (const [k, v] of Object.entries(node.attrs || {})) {
		haystack.push(k)
		if (typeof v === 'string') {
			haystack.push(v)
		}
	}

	const joined = haystack.join(' ').toLowerCase()
	if (keywords.some(kw => joined.includes(kw))) {
		return true
	}

	const content = node.content
	if (Array.isArray(content)) {
		return content.some(
			child => !!child && typeof child === 'object' && !(child instanceof Uint8Array) && nodeMentions(child, keywords)
		)
	}

	return false
}

const isMostlyPrintable = (buf: Buffer): boolean => {
	if (!buf.length) {
		return false
	}

	let printable = 0
	for (const byte of buf) {
		// tab, LF, CR, or printable ASCII
		if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) {
			printable++
		}
	}

	return printable / buf.length > 0.85
}

/**
 * Render binary content readably: decode text (and pretty-print JSON, e.g. the
 * WebAuthn `passkey_request_options` challenge) instead of dumping hex.
 */
const renderContent = (content: BinaryNode['content'], indent: string): string => {
	if (content === undefined || content === null) {
		return ''
	}

	if (typeof content === 'string') {
		return indent + content
	}

	if (content instanceof Uint8Array) {
		const buf = Buffer.from(content)
		if (isMostlyPrintable(buf)) {
			const text = buf.toString('utf-8')
			try {
				const pretty = JSON.stringify(JSON.parse(text), null, 2)
				return indent + pretty.split('\n').join('\n' + indent)
			} catch {
				return indent + text
			}
		}

		return indent + buf.toString('hex')
	}

	if (Array.isArray(content)) {
		return content.map(child => renderNode(child, indent)).join('\n')
	}

	return renderNode(content, indent)
}

/** binaryNodeToString-style renderer, but text/JSON-aware for readability */
const renderNode = (node: BinaryNode, indent = ''): string => {
	const attrs = Object.entries(node.attrs || {})
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}='${v}'`)
		.join(' ')

	const open = `${indent}<${node.tag}${attrs ? ' ' + attrs : ''}`
	const inner = renderContent(node.content, indent + '  ')

	return inner ? `${open}>\n${inner}\n${indent}</${node.tag}>` : `${open}/>`
}

/**
 * Attach a listener that dumps only the nodes of WhatsApp's passkey ("Shortcake")
 * device-linking ceremony — inbound and outbound — to a file, so the exact IQ
 * round-trips can be inspected (see issue #2672).
 *
 * This is a debugging aid: run a link attempt with it attached, then read the file
 * to see whether the server only asks for a WebAuthn assertion (`get`) or also
 * performs a credential registration (`create`) that it accepts from the companion.
 *
 * @example
 * const sock = makeWASocket({ ... })
 * const capture = captureShortcakeCeremony(sock, { filePath: './shortcake.log', logger })
 * // ...attempt to link the passkey-protected account...
 * // inspect ./shortcake.log, then: capture.stop()
 */
export const captureShortcakeCeremony = (
	sock: CaptureSocket,
	options: ShortcakeCaptureOptions = {}
): ShortcakeCaptureHandle => {
	const filePath = options.filePath || './shortcake-capture.log'
	const keywords = [...DEFAULT_KEYWORDS, ...(options.extraKeywords || [])].map(kw => kw.toLowerCase())
	const matcher = options.matcher || (node => nodeMentions(node, keywords))
	let count = 0

	writeFileSync(
		filePath,
		[
			'# Baileys shortcake/passkey ceremony capture',
			`# started ${new Date().toISOString()}`,
			`# keywords: ${keywords.join(', ')}`,
			'',
			''
		].join('\n'),
		{ flag: 'w' }
	)

	const makeHandler = (direction: Direction) => (node: BinaryNode) => {
		try {
			// the 'frame' event also fires for raw (non-node) frames; skip those
			if (!node || typeof node !== 'object' || node instanceof Uint8Array) {
				return
			}

			if (!matcher(node, direction)) {
				return
			}

			count++
			const arrow = direction === 'recv' ? '<<<<< RECV' : '>>>>> SEND'
			appendFileSync(filePath, `${arrow}  ${new Date().toISOString()}\n${renderNode(node)}\n\n`)
			options.logger?.info(
				{ direction, tag: node.tag, type: node.attrs?.type, xmlns: node.attrs?.xmlns },
				'captured shortcake ceremony node'
			)
		} catch (err) {
			options.logger?.error({ err }, 'failed to capture shortcake ceremony node')
		}
	}

	const onRecv = makeHandler('recv')
	const onSend = makeHandler('send')
	sock.ws.on('frame', onRecv)
	sock.ws.on('node.send', onSend)

	return {
		filePath,
		count: () => count,
		stop: () => {
			sock.ws.off('frame', onRecv)
			sock.ws.off('node.send', onSend)
		}
	}
}
