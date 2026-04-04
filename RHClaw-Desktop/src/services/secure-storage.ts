const SECURE_DB_NAME = 'rhopenclaw_secure_storage';
const SECURE_STORE_NAME = 'secure_entries';
const DEVICE_TOKEN_KEY = 'device-token-cipher';
const DEVICE_TOKEN_CRYPTO_KEY = 'device-token-key';
const LEGACY_DEVICE_TOKEN_KEY = 'rhopenclaw_device_token';
const LEGACY_SHELL_STATE_KEY = 'rhopenclaw_desktop_shell_state';
const SESSION_DEVICE_TOKEN_KEY = 'rhopenclaw_session_device_token';

let memoryToken = '';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
    };
    __TAURI_INTERNALS__?: {
      invoke?: TauriInvoke;
    };
  }
}

export type SecureStorageMode = 'native_secure_store' | 'encrypted_indexeddb' | 'session_memory' | 'memory';

export interface SecureTokenState {
  token?: string;
  mode: SecureStorageMode;
  detail: string;
  migratedLegacy: boolean;
}

interface EncryptedTokenEnvelope {
  cipherText: string;
  iv: string;
  updatedAt: string;
}

function getTauriInvoke(): TauriInvoke | null {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
}

async function tryPromoteTokenToNativeStore(token: string, migratedLegacy: boolean, sourceLabel: string): Promise<SecureTokenState | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return null;
  }

  const nativeInvoke = getTauriInvoke();
  if (!nativeInvoke) {
    return null;
  }

  try {
    await nativeInvoke('save_device_secret_stub', { secret: normalizedToken });
    memoryToken = normalizedToken;
    clearSessionFallback();

    return {
      token: normalizedToken,
      mode: 'native_secure_store',
      detail: migratedLegacy
        ? `旧令牌已从${sourceLabel}恢复并回写 Tauri 原生安全存储`
        : `设备令牌已从${sourceLabel}恢复并回写 Tauri 原生安全存储`,
      migratedLegacy,
    };
  } catch {
    return null;
  }
}

async function tryRecoverNativeTokenFromRHClawEnv(migratedLegacy: boolean): Promise<SecureTokenState | null> {
  const nativeInvoke = getTauriInvoke();
  if (!nativeInvoke) {
    return null;
  }

  try {
    const token = (await nativeInvoke<string>('recover_device_secret_stub')).trim();
    if (!token) {
      return null;
    }

    await nativeInvoke('save_device_secret_stub', { secret: token });
    memoryToken = token;
    clearSessionFallback();

    return {
      token,
      mode: 'native_secure_store',
      detail: migratedLegacy ? '旧令牌已从 RHClaw 配置恢复并回写原生安全存储' : '设备令牌已从 RHClaw 配置恢复并回写原生安全存储',
      migratedLegacy,
    };
  } catch {
    return null;
  }
}

export async function loadDeviceTokenSecurely(): Promise<SecureTokenState> {
  const migratedLegacy = await migrateLegacyDeviceToken();

  const nativeResult = await tryLoadNativeToken(migratedLegacy);
  if (nativeResult) {
    return nativeResult;
  }

  const recoveredNativeResult = await tryRecoverNativeTokenFromRHClawEnv(migratedLegacy);
  if (recoveredNativeResult) {
    return recoveredNativeResult;
  }

  if (canUseEncryptedIndexedDb()) {
    try {
      const envelope = await getEntry<EncryptedTokenEnvelope>(DEVICE_TOKEN_KEY);
      if (!envelope) {
        return {
          mode: 'encrypted_indexeddb',
          detail: migratedLegacy ? '旧令牌已迁移到加密存储' : '未发现已保存令牌',
          migratedLegacy,
        };
      }

      const cryptoKey = await getOrCreateCryptoKey();
      const plainBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToUint8Array(envelope.iv),
        },
        cryptoKey,
        base64ToUint8Array(envelope.cipherText),
      );

      const token = new TextDecoder().decode(plainBuffer);
      memoryToken = token;

      const promotedNativeResult = await tryPromoteTokenToNativeStore(token, migratedLegacy, '加密存储');
      if (promotedNativeResult) {
        return promotedNativeResult;
      }

      return {
        token,
        mode: 'encrypted_indexeddb',
        detail: migratedLegacy ? '旧令牌已迁移并从加密存储恢复' : '设备令牌已从加密存储恢复',
        migratedLegacy,
      };
    } catch {
      await clearIndexedDbToken();
      return loadSessionFallback(migratedLegacy, '加密存储读取失败，已回退到会话存储');
    }
  }

  const sessionFallback = loadSessionFallback(migratedLegacy, '当前环境不支持本地加密存储，已回退到会话存储');
  if (sessionFallback.token) {
    const promotedNativeResult = await tryPromoteTokenToNativeStore(sessionFallback.token, migratedLegacy, '会话存储');
    if (promotedNativeResult) {
      return promotedNativeResult;
    }
  }

  return sessionFallback;
}

export async function saveDeviceTokenSecurely(token: string): Promise<SecureTokenState> {
  memoryToken = token;

  const nativeInvoke = getTauriInvoke();
  if (nativeInvoke) {
    try {
      await nativeInvoke('save_device_secret_stub', { secret: token });
      clearLegacyDeviceTokenArtifacts();
      clearSessionFallback();
      await clearIndexedDbToken();

      return {
        token,
        mode: 'native_secure_store',
        detail: '设备令牌已写入 Tauri 原生安全存储',
        migratedLegacy: false,
      };
    } catch {
      // continue with browser fallback chain
    }
  }

  if (canUseEncryptedIndexedDb()) {
    try {
      const cryptoKey = await getOrCreateCryptoKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipherBuffer = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
        },
        cryptoKey,
        new TextEncoder().encode(token),
      );

      await setEntry(DEVICE_TOKEN_KEY, {
        cipherText: uint8ArrayToBase64(new Uint8Array(cipherBuffer)),
        iv: uint8ArrayToBase64(iv),
        updatedAt: new Date().toISOString(),
      } satisfies EncryptedTokenEnvelope);

      clearLegacyDeviceTokenArtifacts();
      clearSessionFallback();

      return {
        token,
        mode: 'encrypted_indexeddb',
        detail: '设备令牌已写入加密存储',
        migratedLegacy: false,
      };
    } catch {
      clearSessionFallback();
      saveSessionFallback(token);
      return {
        token,
        mode: 'session_memory',
        detail: '加密存储写入失败，令牌仅保存在当前会话',
        migratedLegacy: false,
      };
    }
  }

  saveSessionFallback(token);
  clearLegacyDeviceTokenArtifacts();
  return {
    token,
    mode: 'session_memory',
    detail: '当前环境不支持加密存储，令牌仅保存在当前会话',
    migratedLegacy: false,
  };
}

export async function clearDeviceTokenSecurely(): Promise<void> {
  memoryToken = '';
  clearSessionFallback();
  clearLegacyDeviceTokenArtifacts();
  await clearIndexedDbToken();

  const nativeInvoke = getTauriInvoke();
  if (nativeInvoke) {
    try {
      await nativeInvoke('clear_device_secret_stub');
    } catch {
      // ignore
    }
  }
}

async function tryLoadNativeToken(migratedLegacy: boolean): Promise<SecureTokenState | null> {
  const nativeInvoke = getTauriInvoke();
  if (!nativeInvoke) {
    return null;
  }

  try {
    const token = (await nativeInvoke<string>('load_device_secret_stub')).trim();
    if (!token) {
      return {
        mode: 'native_secure_store',
        detail: migratedLegacy ? '旧令牌已迁移到 Tauri 原生安全存储' : '未发现已保存令牌',
        migratedLegacy,
      };
    }

    memoryToken = token;
    clearSessionFallback();

    return {
      token,
      mode: 'native_secure_store',
      detail: migratedLegacy ? '旧令牌已迁移并从 Tauri 原生安全存储恢复' : '设备令牌已从 Tauri 原生安全存储恢复',
      migratedLegacy,
    };
  } catch {
    return null;
  }
}

function loadSessionFallback(migratedLegacy: boolean, detail: string): SecureTokenState {
  const token = readSessionFallback();
  return {
    token: token || undefined,
    mode: token ? 'session_memory' : 'memory',
    detail,
    migratedLegacy,
  };
}

async function migrateLegacyDeviceToken(): Promise<boolean> {
  const legacyToken = readLegacyDeviceToken();
  if (!legacyToken) {
    return false;
  }

  const result = await saveDeviceTokenSecurely(legacyToken);
  clearLegacyDeviceTokenArtifacts();
  return Boolean(result.token);
}

function readLegacyDeviceToken(): string {
  const directToken = safeLocalStorageGet(LEGACY_DEVICE_TOKEN_KEY);
  if (directToken) {
    return directToken;
  }

  const shellRaw = safeLocalStorageGet(LEGACY_SHELL_STATE_KEY);
  if (!shellRaw) {
    return '';
  }

  try {
    const parsed = JSON.parse(shellRaw) as { deviceToken?: string };
    return parsed.deviceToken?.trim() || '';
  } catch {
    return '';
  }
}

function clearLegacyDeviceTokenArtifacts() {
  safeLocalStorageRemove(LEGACY_DEVICE_TOKEN_KEY);

  const shellRaw = safeLocalStorageGet(LEGACY_SHELL_STATE_KEY);
  if (!shellRaw) {
    return;
  }

  try {
    const parsed = JSON.parse(shellRaw) as Record<string, unknown>;
    if (!('deviceToken' in parsed)) {
      return;
    }

    delete parsed.deviceToken;
    localStorage.setItem(LEGACY_SHELL_STATE_KEY, JSON.stringify(parsed));
  } catch {
    safeLocalStorageRemove(LEGACY_SHELL_STATE_KEY);
  }
}

function saveSessionFallback(token: string) {
  memoryToken = token;
  try {
    sessionStorage.setItem(SESSION_DEVICE_TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

function readSessionFallback() {
  if (memoryToken) {
    return memoryToken;
  }

  try {
    const token = sessionStorage.getItem(SESSION_DEVICE_TOKEN_KEY) || '';
    memoryToken = token;
    return token;
  } catch {
    return memoryToken;
  }
}

function clearSessionFallback() {
  try {
    sessionStorage.removeItem(SESSION_DEVICE_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function canUseEncryptedIndexedDb() {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && Boolean(window.crypto?.subtle);
}

async function getOrCreateCryptoKey(): Promise<CryptoKey> {
  const existing = await getEntry<CryptoKey>(DEVICE_TOKEN_CRYPTO_KEY);
  if (existing) {
    return existing;
  }

  const key = await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt'],
  );

  await setEntry(DEVICE_TOKEN_CRYPTO_KEY, key);
  return key;
}

async function clearIndexedDbToken() {
  if (!canUseEncryptedIndexedDb()) {
    return;
  }

  await deleteEntry(DEVICE_TOKEN_KEY);
}

async function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SECURE_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SECURE_STORE_NAME)) {
        db.createObjectStore(SECURE_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getEntry<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECURE_STORE_NAME, 'readonly');
    const store = tx.objectStore(SECURE_STORE_NAME);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

async function setEntry<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECURE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SECURE_STORE_NAME);
    store.put(value, key);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteEntry(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SECURE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(SECURE_STORE_NAME);
    store.delete(key);

    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

function uint8ArrayToBase64(input: Uint8Array) {
  let binary = '';
  input.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToUint8Array(input: string) {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function safeLocalStorageGet(key: string) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function safeLocalStorageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
