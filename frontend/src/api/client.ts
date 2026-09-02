const AUTH_STORAGE_KEY = 'nexasupport_auth'
const BASE_URL = import.meta.env.VITE_BACKEND_URL || ''

// TODO: keep this direct fetch wrapper only for non-standard requests that still need a raw URL-based call.
async function fetchWithBaseUrl(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, options)
}

export interface StoredAuth {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
    role?: 'user' | 'admin' | 'agent' | 'head'
    team?: string | null
  }
}

export function getStoredAuth(): StoredAuth | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredAuth
  } catch {
    return null
  }
}

export function setStoredAuth(auth: StoredAuth) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth))
}

export function clearStoredAuth() {
  localStorage.removeItem(AUTH_STORAGE_KEY)
}

export function getAccessToken(): string | null {
  return getStoredAuth()?.accessToken ?? null
}

export async function refreshSession(): Promise<StoredAuth | null> {
  const stored = getStoredAuth()
  if (!stored?.refreshToken) {
    return null
  }

  const res = await fetchWithBaseUrl('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: stored.refreshToken }),
  })

  if (!res.ok) {
    return null
  }

  const data = (await res.json().catch(() => null)) as {
    accessToken?: string
    refreshToken?: string
  } | null

  if (!data?.accessToken || !data?.refreshToken) {
    return null
  }

  const nextAuth = {
    ...stored,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  }

  setStoredAuth(nextAuth)
  return nextAuth
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAccessToken()
  const headers = new Headers(options.headers)

  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  const res = await fetchWithBaseUrl(path, { ...options, headers })

  if (res.status === 401) {
    const refreshed = await refreshSession()
    if (refreshed) {
      const retryHeaders = new Headers(options.headers)
      retryHeaders.set('Authorization', `Bearer ${refreshed.accessToken}`)
      const retryRes = await fetchWithBaseUrl(path, {
        ...options,
        headers: retryHeaders,
      })

      if (!retryRes.ok) {
        const body = (await retryRes.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Request failed (${retryRes.status})`)
      }

      return retryRes.json() as Promise<T>
    }
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }

  if (res.status === 204) {
    return undefined as unknown as T
  }

  return res.json() as Promise<T>
}