import { useEffect, useState } from 'react'
// import { useNavigate } from 'react-router-dom'
import {
  Settings as SettingsIcon,
  Copy,
  Check,
  RefreshCw,

  Plus,
  X,
} from 'lucide-react'
import {
  getSettings,
  updateWidgetConfig,
  regenerateWidgetKey,
  type Organization,
  type WidgetConfig,
} from '../api/settings'
import { useAuth } from '../context/AuthContext'
import { AdminHeader } from '../components/adminHeader'

const DEFAULT_CONFIG: Omit<WidgetConfig, 'org_id' | 'updated_at'> = {
  primary_color: '#0f766e',
  bot_name: 'Support Bot',
  avatar_url: '',
  welcome_message: 'Hi! How can I help you today?',
  quick_questions: [],
  bubble_position: 'bottom-right',
  show_history_tab: true,
  escalation_enabled: true,
    support_email: 'contact@support',
}

export function SettingsPage() {
  // const navigate = useNavigate()
  const { user } = useAuth()

  const backendUrl = import.meta.env.VITE_BACKEND_URL;

  const [org, setOrg] = useState<Organization | null>(null)
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [quickQuestionInput, setQuickQuestionInput] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    setIsLoading(true)
    setError('')
    try {
      const data = await getSettings()
      setOrg(data.organization)
      if (data.widgetConfig) {
        setConfig({
          primary_color: data.widgetConfig.primary_color ?? DEFAULT_CONFIG.primary_color,
          bot_name: data.widgetConfig.bot_name ?? DEFAULT_CONFIG.bot_name,
          avatar_url: data.widgetConfig.avatar_url ?? DEFAULT_CONFIG.avatar_url,
          welcome_message: data.widgetConfig.welcome_message ?? DEFAULT_CONFIG.welcome_message,
          quick_questions: data.widgetConfig.quick_questions ?? [],
          bubble_position: data.widgetConfig.bubble_position ?? DEFAULT_CONFIG.bubble_position,
          show_history_tab: data.widgetConfig.show_history_tab ?? true,
          escalation_enabled: data.widgetConfig.escalation_enabled ?? true,
          support_email: data.widgetConfig.support_email ?? DEFAULT_CONFIG.support_email,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleSaveConfig() {
    setIsSaving(true)
    setError('')
    setSuccess('')
    try {
      await updateWidgetConfig(config)
      setSuccess('Widget configuration saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleRegenerateKey() {
    const confirmed = window.confirm(
      'Regenerating the widget key will break any site currently using the old script tag. Continue?',
    )
    if (!confirmed) return

    setIsRegenerating(true)
    setError('')
    setSuccess('')
    try {
      const newKey = await regenerateWidgetKey()
      setOrg((prev) => (prev ? { ...prev, widget_key: newKey } : prev))
      setSuccess('Widget key regenerated. Update your script tag on your site.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate key')
    } finally {
      setIsRegenerating(false)
    }
  }

  function handleAddQuickQuestion() {
    const trimmed = quickQuestionInput.trim()
    if (!trimmed) return
    setConfig((prev) => ({
      ...prev,
      quick_questions: [...(prev.quick_questions ?? []), trimmed],
    }))
    setQuickQuestionInput('')
  }

  function handleRemoveQuickQuestion(index: number) {
    setConfig((prev) => ({
      ...prev,
      quick_questions: (prev.quick_questions ?? []).filter((_, i) => i !== index),
    }))
  }

  async function handleCopySnippet() {
    if (!org) return


    const snippet = `<script src="${backendUrl}/widget.js" data-org="${org.widget_key}"></script>`;
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // const handleLogout = () => {
  //   logout()
  //   navigate('/login', { replace: true })
  // }

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? 'AD'

  return (
    <div className="flex min-h-full flex-col bg-background">
      <AdminHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 md:px-6">
        <div className="mb-8">
          <h1 className="font-ui text-2xl font-medium text-text-primary">Settings</h1>
          <p className="mt-1 font-ui text-sm text-text-secondary">
            Manage your organization's widget installation and configuration
          </p>
        </div>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 font-ui text-sm text-red-600">
            {error}
          </p>
        )}
        {success && (
          <p className="mb-4 rounded-lg bg-accent-light px-4 py-3 font-ui text-sm text-accent-dark">
            {success}
          </p>
        )}

        {isLoading ? (
          <div className="rounded-xl border border-border bg-surface px-6 py-10 text-center font-ui text-sm text-text-hint">
            Loading settings…
          </div>
        ) : (
          <>
            {/* Install widget */}
            <section className="mb-8 rounded-xl border border-border bg-surface p-6">
              <div className="mb-4 flex items-center gap-2">
                <SettingsIcon className="h-5 w-5 text-accent" strokeWidth={2} />
                <h2 className="font-ui text-base font-medium text-text-primary">
                  Install widget
                </h2>
              </div>
              <p className="mb-4 font-ui text-sm text-text-secondary">
                Paste this script tag before the closing{' '}
                <code className="rounded bg-surface-muted px-1 py-0.5 text-xs">
                  &lt;/body&gt;
                </code>{' '}
                tag on your site.
              </p>

              <div className="mb-4 rounded-lg border border-border bg-surface-muted px-4 py-3">
                <code className="break-all font-mono text-xs text-text-primary">
                  {`<script src="${backendUrl}/widget.js" data-org="${org?.widget_key ?? ''}"></script>`}
                </code>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCopySnippet}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 font-ui text-xs font-medium text-white transition-all duration-150 hover:bg-accent-dark"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5" strokeWidth={2} />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                      Copy snippet
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleRegenerateKey}
                  disabled={isRegenerating}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 font-ui text-xs text-text-secondary transition-all duration-150 hover:bg-accent-light hover:text-accent disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isRegenerating ? 'animate-spin' : ''}`}
                    strokeWidth={2}
                  />
                  {isRegenerating ? 'Regenerating…' : 'Regenerate key'}
                </button>
              </div>
            </section>

            {/* Widget configuration */}
            <section className="rounded-xl border border-border bg-surface p-6">
              <div className="mb-1 flex items-center gap-2">
                <SettingsIcon className="h-5 w-5 text-accent" strokeWidth={2} />
                <h2 className="font-ui text-base font-medium text-text-primary">
                  Widget configuration
                </h2>
              </div>
              <p className="mb-5 font-ui text-sm text-text-secondary">
                Customize how the chat widget looks and behaves on your site.
              </p>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Bot name
                  </label>
                  <input
                    type="text"
                    value={config.bot_name ?? ''}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, bot_name: e.target.value }))
                    }
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Primary color
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={config.primary_color ?? '#0f766e'}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, primary_color: e.target.value }))
                      }
                      className="h-9 w-9 shrink-0 rounded-lg border border-border bg-background p-1"
                    />
                    <input
                      type="text"
                      value={config.primary_color ?? ''}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, primary_color: e.target.value }))
                      }
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                    />
                  </div>
                </div>

                <div className="sm:col-span-2">
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Avatar URL
                  </label>
                  <input
                    type="text"
                    value={config.avatar_url ?? ''}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, avatar_url: e.target.value }))
                    }
                    placeholder="https://…"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Welcome message
                  </label>
                  <textarea
                    value={config.welcome_message ?? ''}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, welcome_message: e.target.value }))
                    }
                    rows={2}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Bubble position
                  </label>
                  <select
                    value={config.bubble_position ?? 'bottom-right'}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, bubble_position: e.target.value }))
                    }
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                  >
                    <option value="bottom-right">Bottom right</option>
                    <option value="bottom-left">Bottom left</option>
                  </select>
                </div>

                <div className="flex flex-col justify-center gap-2">
                  <label className="flex items-center gap-2 font-ui text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={config.show_history_tab ?? true}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, show_history_tab: e.target.checked }))
                      }
                      className="h-4 w-4 rounded border-border accent-accent"
                    />
                    Show chat history tab
                  </label>
                  <label className="flex items-center gap-2 font-ui text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={config.escalation_enabled ?? true}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          escalation_enabled: e.target.checked,
                        }))
                      }
                      className="h-4 w-4 rounded border-border accent-accent"
                    />
                    Allow escalation to human agent
                  </label>
                </div>

                 <div>
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Support Email
                  </label>
                  <input
                    type="text"
                    value={config.support_email ?? ''}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, support_email: e.target.value }))
                    }
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                  />
                </div>

                

                <div className="sm:col-span-2">
                  <label className="mb-1 block font-ui text-xs font-medium text-text-secondary">
                    Quick questions
                  </label>
                  <div className="mb-2 flex gap-2">
                    <input
                      type="text"
                      value={quickQuestionInput}
                      onChange={(e) => setQuickQuestionInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleAddQuickQuestion()
                        }
                      }}
                      placeholder="Add a suggested question"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 font-ui text-sm text-text-primary outline-none transition-all duration-150 focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={handleAddQuickQuestion}
                      className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-2 font-ui text-xs text-text-secondary transition-all duration-150 hover:bg-accent-light hover:text-accent"
                    >
                      <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                      Add
                    </button>
                  </div>
                  {(config.quick_questions ?? []).length > 0 && (
                    <ul className="space-y-1.5">
                      {(config.quick_questions ?? []).map((q, i) => (
                        <li
                          key={i}
                          className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-2 font-ui text-sm text-text-primary"
                        >
                          <span className="truncate">{q}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveQuickQuestion(i)}
                            className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-hint transition-all duration-150 hover:bg-red-50 hover:text-red-600"
                            aria-label="Remove quick question"
                          >
                            <X className="h-3.5 w-3.5" strokeWidth={2} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={handleSaveConfig}
                disabled={isSaving}
                className="mt-6 rounded-lg bg-accent px-4 py-2 font-ui text-xs font-medium text-white transition-all duration-150 hover:bg-accent-dark disabled:opacity-50"
              >
                {isSaving ? 'Saving…' : 'Save configuration'}
              </button>
            </section>
          </>
        )}
      </main>

      <footer className="border-t border-border bg-surface px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-light">
            <span className="font-ui text-xs font-medium text-accent">{initials}</span>
          </div>
          <div className="min-w-0">
            <p className="truncate font-ui text-xs text-text-primary">Admin</p>
            <p className="truncate font-ui text-xs text-text-hint">{user?.email}</p>
          </div>
        </div>
      </footer>
    </div>
  )
}