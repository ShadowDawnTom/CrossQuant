import { randomBytes } from 'node:crypto';

const styles = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#070c14;color:#e9f0fb}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;background:radial-gradient(circle at top,#102530,#070c14 48%)}
main{width:min(100%,620px);padding:32px;border:1px solid #29384d;border-radius:16px;background:#0c1421;box-shadow:0 28px 80px #0008}
.eyebrow{margin:0 0 10px;color:#5eead4;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.13em}h1{margin:0 0 12px;font-size:32px;letter-spacing:-.04em}p{color:#95a3b8;line-height:1.6}.notice{padding:14px;border:1px solid #3f4d27;border-radius:9px;background:#171b10;color:#d9df9b}.error{border-color:#713f2b;background:#24150f;color:#fdba74}
form{display:grid;gap:16px;margin-top:24px}label{display:grid;gap:7px;color:#cbd6e6;font-size:13px}input{width:100%;padding:12px;border:1px solid #34445a;border-radius:8px;background:#08111e;color:#edf5ff;font:inherit}input:focus{outline:2px solid #2dd4bf;outline-offset:2px}.actions{display:flex;gap:10px;align-items:center;margin-top:8px}.button,button{display:inline-flex;justify-content:center;padding:11px 16px;border:1px solid #2a756b;border-radius:8px;background:#123b37;color:#d5fffa;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.secondary{border-color:#3a475a;background:#131d2b;color:#cbd6e6}.danger{width:100%;border-color:#8a4527;background:#321a11;color:#fed7aa}.action-detail{display:block;margin-top:-7px;color:#7f8ca2;line-height:1.45}.danger-zone{margin-top:28px;padding:18px;border:1px solid #713f2b;border-radius:10px;background:#180f0c}.danger-zone h2{margin:0;color:#fed7aa;font-size:16px}.danger-zone p{margin:7px 0 0;color:#c99f8d;font-size:12px;line-height:1.5}.danger-zone form{margin-top:14px}.small{font-size:12px}.footer{margin-top:24px;padding-top:18px;border-top:1px solid #202d3f}
fieldset{margin:0;padding:0;border:0}legend{margin-bottom:8px;color:#cbd6e6;font-size:13px}.storage-options{display:grid;grid-template-columns:1fr 1fr;gap:10px}.storage-option{display:flex;align-items:flex-start;gap:10px;padding:13px;border:1px solid #34445a;border-radius:9px;background:#08111e}.storage-option input{width:auto;margin-top:3px}.storage-option span{display:grid;gap:3px}.storage-option small{color:#7f8ca2;line-height:1.35}@media(max-width:560px){body{padding:14px}main{padding:22px}.storage-options{grid-template-columns:1fr}.actions{flex-direction:column;align-items:stretch}.actions .button,.actions button{width:100%}}
`;

export type SecureCredentialLanguage = 'en' | 'zh';

const credentialCopy = {
  en: {
    entryTitle: 'Secure Gate credential setup',
    entryEyebrow: 'Script-free secure setup',
    entryHeading: 'Gate CrossEx credentials',
    replacementHeading: 'Replace saved Gate credentials',
    entryIntro: 'This isolated page runs with JavaScript disabled. On submission, the local backend verifies the credential with <code>GET /crossex/accounts</code>. Credentials are stored only after that request succeeds.',
    noStorage: 'No credential storage provider is available.',
    replace: 'Verify & save replacement',
    store: 'Verify and store credentials',
    replacementDetail: 'The new key is verified first. Your currently saved key is replaced only if verification succeeds.',
    deleteSaved: 'Delete current saved credentials',
    dangerTitle: 'Danger zone',
    dangerDetail: 'Deletes the credentials currently stored on this computer. The values entered above are not submitted by this action.',
    livePermission: 'This backend is in live mode. Use a dedicated APIv4 key with CrossEx read and trade permissions. Keep wallet write and withdrawal permissions disabled.',
    liveIntentPermission: 'You are setting up live trading. Use a dedicated APIv4 key with CrossEx read and trade permissions. Keep wallet write and withdrawal permissions disabled.',
    readonlyPermission: 'Use a dedicated APIv4 key with read-only CrossEx permissions. Keep wallet write and withdrawal permissions disabled.',
    testnet: "CrossEx testnet is not enabled because Gate's CrossEx documentation currently lists only production URLs.",
    storage: 'Credential storage',
    keychain: 'OS keychain',
    keychainDetail: 'Recommended. Encrypted and managed by your operating system.',
    envFile: 'Local .env file',
    envFileDetail: 'Plaintext in the project root with owner-only file permissions.',
    connectionLabel: 'Connection label',
    apiKey: 'Gate APIv4 key',
    apiSecret: 'Gate APIv4 secret',
    cancel: 'Cancel',
    footer: 'Secrets are never written to SQLite, logs, diagnostic output, or Web Storage. Choosing <strong>Local .env file</strong> writes them to the gitignored project-root <code>.env</code> with owner-only permissions.',
    successTitle: 'Gate connection verified',
    successEyebrow: 'Credential verification complete',
    successHeading: 'Connection secured',
    verifiedAndStored: 'was verified and stored in',
    envDestination: 'the local .env file',
    keychainDestination: 'the operating-system credential vault',
    accountMode: 'Account mode',
    visibleVenues: 'Visible venues',
    noneReturned: 'None returned',
    finishLive: 'Return to the trading-mode dialog and select <strong>I\'ve saved credentials — enable live trading</strong> to finish.',
    returnDashboard: 'Return to dashboard',
    deletedTitle: 'Gate credentials removed',
    deletedEyebrow: 'Credential removal complete',
    deletedHeading: 'Saved credentials deleted',
    deletedBody: 'The credential bundle was removed from configured local storage and its non-secret metadata was removed from SQLite.',
  },
  zh: {
    entryTitle: 'Gate API 密钥设置',
    entryEyebrow: '无脚本安全设置',
    entryHeading: '添加 Gate API 密钥',
    replacementHeading: '替换已保存的 Gate API 密钥',
    entryIntro: '此隔离页面已禁用 JavaScript。提交后，本地后端将通过 <code>GET /crossex/accounts</code> 验证 API 密钥。仅在该请求成功后才会存储 API 密钥。',
    noStorage: '没有可用的 API 密钥存储方式。',
    replace: '验证并保存新密钥',
    store: '验证并存储 API 密钥',
    replacementDetail: '系统会先验证上方的新密钥。仅验证成功后，才会替换当前已保存的密钥。',
    deleteSaved: '删除当前已保存的 API 密钥',
    dangerTitle: '危险操作',
    dangerDetail: '删除当前存储在此电脑上的密钥。点击此按钮不会提交上方输入的新密钥。',
    livePermission: '当前后端处于实盘模式。请使用具备 CrossEx 读取和交易权限的专用 APIv4 密钥。请勿启用钱包写入和提现权限。',
    liveIntentPermission: '您正在设置实盘交易。请使用具备 CrossEx 读取和交易权限的专用 APIv4 密钥。请勿启用钱包写入和提现权限。',
    readonlyPermission: '请使用具备 CrossEx 只读权限的专用 APIv4 密钥。请勿启用钱包写入和提现权限。',
    testnet: 'Gate 的 CrossEx 文档目前仅列出生产环境地址，因此本应用未启用 CrossEx 测试网。',
    storage: 'API 密钥存储',
    keychain: '系统钥匙串',
    keychainDetail: '推荐使用。由您的操作系统加密和管理。',
    envFile: '本地 .env 文件',
    envFileDetail: '以明文存储在项目根目录，仅限文件所有者访问。',
    connectionLabel: '连接名称',
    apiKey: 'Gate APIv4 密钥',
    apiSecret: 'Gate APIv4 密钥密码',
    cancel: '取消',
    footer: 'API 密钥绝不会写入 SQLite、日志、诊断输出或 Web Storage。选择<strong>本地 .env 文件</strong>后，API 密钥将写入已被 Git 忽略的项目根目录 <code>.env</code>，且文件权限仅限所有者。',
    successTitle: 'Gate 连接已验证',
    successEyebrow: 'API 密钥验证完成',
    successHeading: '连接已安全保存',
    verifiedAndStored: '已验证并存储在',
    envDestination: '本地 .env 文件中',
    keychainDestination: '操作系统密钥库中',
    accountMode: '账户模式',
    visibleVenues: '可见交易所',
    noneReturned: '未返回任何交易所',
    finishLive: '请返回交易模式对话框并选择<strong>我已保存API密钥 — 启用实盘交易</strong>以完成设置。',
    returnDashboard: '返回控制台',
    deletedTitle: 'Gate API 密钥已移除',
    deletedEyebrow: 'API 密钥移除完成',
    deletedHeading: '已删除保存的 API 密钥',
    deletedBody: 'API 密钥已从配置的本地存储中移除，其不含密钥的元数据也已从 SQLite 中删除。',
  },
} as const;

function page(title: string, content: string, language: SecureCredentialLanguage): { html: string; csp: string } {
  const nonce = randomBytes(18).toString('base64url');
  return {
    csp: `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    html: `<!doctype html><html lang="${language === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><style nonce="${nonce}">${styles}</style></head><body><main>${content}</main></body></html>`,
  };
}

export function renderCredentialEntryPage(options: {
  csrfToken: string;
  configured: boolean;
  storageAvailable: boolean;
  storageProviders?: readonly string[];
  configuredStorageProvider?: string;
  tradingEnabled?: boolean;
  liveTradingIntent?: boolean;
  language?: SecureCredentialLanguage;
  errorMessage?: string;
}): { html: string; csp: string } {
  const language = options.language ?? 'en';
  const copy = credentialCopy[language];
  const error = options.errorMessage
    ? `<p class="notice error" role="alert">${escapeHtml(options.errorMessage)}</p>`
    : '';
  const disabled = options.storageAvailable ? '' : ' disabled';
  const storageWarning = options.storageAvailable
    ? ''
    : `<p class="notice error">${copy.noStorage}</p>`;
  const heading = options.configured ? copy.replacementHeading : copy.entryHeading;
  const replaceText = options.configured ? copy.replace : copy.store;
  const languageField = `<input type="hidden" name="lang" value="${language}">`;
  const replacementDetail = options.configured
    ? `<small class="action-detail">${copy.replacementDetail}</small>`
    : '';
  const deleteSection = options.configured
    ? `<section class="danger-zone" aria-labelledby="danger-zone-title">
        <h2 id="danger-zone-title">${copy.dangerTitle}</h2>
        <p>${copy.dangerDetail}</p>
        <form method="post" action="/secure/credentials/delete"><input type="hidden" name="csrfToken" value="${options.csrfToken}">${languageField}<button class="danger" type="submit"${disabled}>${copy.deleteSaved}</button></form>
      </section>`
    : '';
  const permissionCopy = options.tradingEnabled
    ? copy.livePermission
    : options.liveTradingIntent
      ? copy.liveIntentPermission
      : copy.readonlyPermission;
  const intentField = options.liveTradingIntent
    ? '<input type="hidden" name="intent" value="live-trading">'
    : '';
  const providers = options.storageProviders ?? [];
  const defaultProvider = options.configuredStorageProvider && providers.includes(options.configuredStorageProvider)
    ? options.configuredStorageProvider
    : providers.includes('os_keychain') ? 'os_keychain' : providers[0];
  const storageOptions = providers.length ? `<fieldset><legend>${copy.storage}</legend><div class="storage-options">
    ${providers.includes('os_keychain') ? `<label class="storage-option"><input type="radio" name="storageProvider" value="os_keychain"${defaultProvider === 'os_keychain' ? ' checked' : ''}><span><strong>${copy.keychain}</strong><small>${copy.keychainDetail}</small></span></label>` : ''}
    ${providers.includes('env_file') ? `<label class="storage-option"><input type="radio" name="storageProvider" value="env_file"${defaultProvider === 'env_file' ? ' checked' : ''}><span><strong>${copy.envFile}</strong><small>${copy.envFileDetail}</small></span></label>` : ''}
  </div></fieldset>` : '';

  return page(copy.entryTitle, `
    <p class="eyebrow">${copy.entryEyebrow}</p>
    <h1>${heading}</h1>
    <p>${copy.entryIntro}</p>
    <p class="notice">${permissionCopy} ${copy.testnet}</p>
    ${storageWarning}${error}
    <form method="post" action="/secure/credentials" autocomplete="off">
      <input type="hidden" name="csrfToken" value="${options.csrfToken}">
      ${languageField}
      ${intentField}
      <label>${copy.connectionLabel}<input name="label" required minlength="1" maxlength="80" value="Gate CrossEx"></label>
      <label>${copy.apiKey}<input name="apiKey" type="password" required minlength="8" maxlength="256" autocomplete="off" spellcheck="false"></label>
      <label>${copy.apiSecret}<input name="apiSecret" type="password" required minlength="8" maxlength="512" autocomplete="off" spellcheck="false"></label>
      ${storageOptions}
      <div class="actions"><button type="submit"${disabled}>${replaceText}</button><a class="button secondary" href="/">${copy.cancel}</a></div>
      ${replacementDetail}
    </form>
    ${deleteSection}
    <p class="footer small">${copy.footer}</p>
  `, language);
}

export function renderCredentialSuccessPage(options: {
  label: string;
  accountMode: string;
  venues: string[];
  storageProvider: string;
  liveTradingIntent?: boolean;
  language?: SecureCredentialLanguage;
}): { html: string; csp: string } {
  const language = options.language ?? 'en';
  const copy = credentialCopy[language];
  return page(copy.successTitle, `
    <p class="eyebrow">${copy.successEyebrow}</p>
    <h1>${copy.successHeading}</h1>
    <p class="notice">${escapeHtml(options.label)} ${copy.verifiedAndStored} ${options.storageProvider === 'env_file' ? copy.envDestination : copy.keychainDestination}.</p>
    <p>${copy.accountMode}: <strong>${escapeHtml(options.accountMode)}</strong><br>${copy.visibleVenues}: <strong>${escapeHtml(options.venues.join(', ') || copy.noneReturned)}</strong></p>
    ${options.liveTradingIntent ? `<p>${copy.finishLive}</p>` : ''}
    <div class="actions"><a class="button" href="/">${copy.returnDashboard}</a></div>
  `, language);
}

export function renderCredentialDeletedPage(options: { language?: SecureCredentialLanguage } = {}): { html: string; csp: string } {
  const language = options.language ?? 'en';
  const copy = credentialCopy[language];
  return page(copy.deletedTitle, `
    <p class="eyebrow">${copy.deletedEyebrow}</p>
    <h1>${copy.deletedHeading}</h1>
    <p>${copy.deletedBody}</p>
    <div class="actions"><a class="button" href="/">${copy.returnDashboard}</a></div>
  `, language);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}
