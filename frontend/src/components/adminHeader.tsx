import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { LogOut, Shield, Users, Menu, X } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const NAV_ITEMS = [
    { label: 'knowledge Base', path: '/admin' },
    { label: 'Analytics', path: '/analytics' },
  { label: 'Tickets', path: '/dashboard' },
  { label: 'Settings', path: '/settings' },
  { label: 'Manage Agents', path: '/manageAgents' },
] as const

export function AdminHeader() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  const role = user?.role ?? 'agent'
  const team = (user as any)?.team as string | null
  const isAdmin = role === 'admin'

  const RoleIcon = isAdmin ? Shield : Users
  const roleLabel = isAdmin ? 'Admin' : `Agent${team ? ` — ${team}` : ''}`

  const handleLogout = () => {
    setMenuOpen(false)
    logout()
    navigate('/login', { replace: true })
  }

  const handleNavigate = (path: string) => {
    setMenuOpen(false)
    navigate(path)
  }

  return (
    <header className="shrink-0 border-b border-border bg-surface">
      <div className="flex h-16 items-center px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
          <span className="truncate font-ui text-base font-medium text-text-primary">
            NexaSupport Admin
          </span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="hidden items-center gap-1.5 sm:flex">
            <RoleIcon className="h-3.5 w-3.5 text-text-hint" strokeWidth={2} />
            <span className="font-ui text-xs text-text-secondary">{roleLabel}</span>
          </div>

          {isAdmin && (
            <nav className="hidden items-center gap-2 lg:flex">
              {NAV_ITEMS.map((item) => {
                const isActive = location.pathname === item.path
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => handleNavigate(item.path)}
                    className={`rounded-lg px-3 py-1.5 font-ui text-xs font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-accent text-white'
                        : 'border border-border text-text-secondary hover:bg-accent-light hover:text-accent'
                    }`}
                  >
                    {item.label}
                  </button>
                )
              })}
            </nav>
          )}

          <button
            type="button"
            onClick={handleLogout}
            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-hint transition-all duration-150 hover:bg-surface-muted hover:text-text-secondary sm:flex"
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" strokeWidth={2} />
          </button>

          {isAdmin && (
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-hint transition-all duration-150 hover:bg-surface-muted hover:text-text-secondary lg:hidden"
            >
              {menuOpen ? (
                <X className="h-4.5 w-4.5" strokeWidth={2} />
              ) : (
                <Menu className="h-4.5 w-4.5" strokeWidth={2} />
              )}
            </button>
          )}

          {/* Logout stays reachable on the smallest screens even without admin nav */}
          {!isAdmin && (
            <button
              type="button"
              onClick={handleLogout}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-hint transition-all duration-150 hover:bg-surface-muted hover:text-text-secondary sm:hidden"
              aria-label="Log out"
            >
              <LogOut className="h-4 w-4" strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* Mobile / tablet dropdown menu */}
      {isAdmin && menuOpen && (
        <div className="border-t border-border bg-surface px-4 py-3 lg:hidden">
          <div className="mb-3 flex items-center gap-1.5 sm:hidden">
            <RoleIcon className="h-3.5 w-3.5 text-text-hint" strokeWidth={2} />
            <span className="font-ui text-xs text-text-secondary">{roleLabel}</span>
          </div>

          <nav className="flex flex-col gap-1.5">
            {NAV_ITEMS.map((item) => {
              const isActive = location.pathname === item.path
              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => handleNavigate(item.path)}
                  className={`rounded-lg px-3 py-2 text-left font-ui text-xs font-medium transition-all duration-150 ${
                    isActive
                      ? 'bg-accent text-white'
                      : 'border border-border text-text-secondary hover:bg-accent-light hover:text-accent'
                  }`}
                >
                  {item.label}
                </button>
              )
            })}
          </nav>

          <button
            type="button"
            onClick={handleLogout}
            className="mt-3 flex w-full items-center gap-1.5 rounded-lg border border-border px-3 py-2 font-ui text-xs font-medium text-text-secondary transition-all duration-150 hover:bg-surface-muted sm:hidden"
          >
            <LogOut className="h-3.5 w-3.5" strokeWidth={2} />
            Log out
          </button>
        </div>
      )}
    </header>
  )
}