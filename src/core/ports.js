/**
 * Ports: the contracts the core depends on. Adapters in src/adapters implement them,
 * and src/app.js picks which implementation to plug in (real, dry-run or fixtures).
 *
 * @typedef {object} IncomingMessage
 * @property {string} id          Stable message id, used as the dedupe key
 * @property {string} chatId
 * @property {string} kind        'image', 'video', ... (see SUPPORTED_KINDS)
 * @property {number} timestamp   Unix seconds
 * @property {() => Promise<{mimetype: string, data: Buffer} | null>} download
 *
 * @typedef {object} MessageSource
 * @property {(handler: (msg: IncomingMessage) => void) => void} onMessage
 * @property {(handler: (reason: string) => void) => void} onDisconnect
 * @property {() => Promise<void>} connect
 * @property {() => Promise<Array<{id: string, name: string}>>} listGroups
 * @property {(groupId: string, limit: number) => Promise<IncomingMessage[]>} fetchHistory  limit 0 = all available
 * @property {(groupId: string) => Promise<number>} [historySize]  Optional; media available so far, used to follow history sync
 * @property {(groupId: string) => Promise<{endOfHistory: boolean, requested?: boolean, state?: string, detail?: string}>} [requestOlderHistory]  Optional; asks for older history
 * @property {() => Promise<void>} disconnect
 *
 * @typedef {object} UploadRequest
 * @property {string} filePath
 * @property {string} filename
 * @property {string} mimetype
 * @property {number} takenAt        Unix seconds
 * @property {string} deviceAssetId  The message id
 *
 * @typedef {object} MediaLibrary
 * @property {() => Promise<void>} verifyAccess  Read-only check; throws when misconfigured
 * @property {(req: UploadRequest) => Promise<{assetId: string, duplicate: boolean}>} upload
 * @property {(assetId: string) => Promise<void>} addToAlbum
 * @property {(items: Array<{id: string, checksum: string}>) => Promise<Map<string, string>>} [findExisting]  id -> existing asset id
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} filename
 * @property {string} mimetype
 * @property {number} takenAt
 * @property {'pending'|'uploaded'|'done'|'failed'} status
 * @property {string|null} assetId
 * @property {number} attempts
 * @property {string|null} lastError
 *
 * @typedef {object} JobRepository
 * @property {(id: string) => boolean} has
 * @property {(job: {id: string, filename: string, mimetype: string, takenAt: number}) => boolean} enqueue
 * @property {(now: number, limit: number) => Job[]} nextBatch
 * @property {(id: string, assetId: string) => void} markUploaded
 * @property {(id: string) => void} markDone
 * @property {(id: string, error: string, retryAt: number|null) => void} recordFailure  null = permanent
 * @property {() => number} retryFailed
 * @property {() => Record<string, number>} stats
 * @property {() => boolean} isPaused
 * @property {(paused: boolean) => void} setPaused
 * @property {(key: string) => string|undefined} getSetting
 * @property {(key: string, value: string) => void} setSetting
 *
 * @typedef {object} MediaStore
 * @property {(name: string) => string} pathOf
 * @property {(name: string) => boolean} exists
 * @property {(name: string, data: Buffer) => Promise<void>} save
 * @property {(name: string) => Promise<void>} remove
 */
export {};
