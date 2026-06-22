export { send } from './core/send.js'
export { getInbox, searchInbox, getEmail, waitForCode, downloadAttachment } from './core/receive.js'
export { getStorage } from './core/storage.js'
export { loadConfig, saveConfig, getConfigValue, setConfigValue } from './core/config.js'
export { createResendProvider } from './providers/send/resend.js'
export { createZeptoMailProvider } from './providers/send/zeptomail.js'
export { createHostedSendProvider } from './providers/send/hosted.js'
export { createOSSSendProvider } from './providers/send/oss.js'
export { createSqliteProvider } from './providers/storage/sqlite.js'
export { createDb9Provider } from './providers/storage/db9.js'
export { createRemoteProvider } from './providers/storage/remote.js'

export type {
  Attachment,
  AttachmentDownload,
  AttachmentTextExtractionStatus,
  Email,
  PreparedAttachment,
  SendAttachment,
  SendOptions,
  SendResult,
  SendProvider,
  StorageProvider,
  EmailQueryOptions,
  EmailSearchOptions,
  MailsConfig,
} from './core/types.js'
