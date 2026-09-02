import {
  apiFetch,
  clearStoredAuth,
  getStoredAuth,
  setStoredAuth,
  type StoredAuth,
} from './client'

export type UserRole = 'user' | 'admin' | 'agent'

export interface AuthUser {
  id: string
  email: string
  role: UserRole
}

export interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

export interface MeResponse {
  user: AuthUser
}

export async function loginUser(email: string, password: string): Promise<AuthUser> {
  let data: LoginResponse

  try {
    data = await apiFetch<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  } catch (error) {
    // If apiFetch throws a structured error (e.g. { message, status }), surface it
    if (error instanceof Error) {
      throw new Error(error.message || 'Login failed. Please check your credentials.')
    }
    throw new Error('Login failed. Please check your credentials.')
  }

  try {
    setStoredAuth({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    })
  } catch (error) {
    throw new Error('Login succeeded but failed to store session. Please try again.')
  }

  try {
    return await fetchMe()
  } catch (error) {
    throw new Error('Login succeeded but failed to fetch user profile.')
  }
}

// export async function registerUser(email: string, password: string): Promise<void> {
//   await apiFetch<{ message: string }>('/api/auth/register', {
//     method: 'POST',
//     body: JSON.stringify({ email, password }),
//   })
// }


export async function registerAdmin(
  email: string,
  password: string,
  organizationName:string,
): Promise<void> {
  await apiFetch<{ message: string }>('/api/auth/admin/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, organizationName }),
  })
}

export async function createAgent(payload: { email: string; password: string }) {
  return apiFetch<{ message?: string; [key: string]: unknown }>('/api/agents', {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(payload),
  })
}

export async function fetchMe(): Promise<AuthUser> {
  const data = await apiFetch<MeResponse>('/api/auth/me')
  const stored = getStoredAuth()
  
  if (stored) {
    setStoredAuth({
      ...stored,
      user: { ...stored.user, role: data.user.role },
    })
  }
  return data.user
}

export function logout() {
  clearStoredAuth()
}

export function restoreSession(): StoredAuth | null {
  return getStoredAuth()
}
