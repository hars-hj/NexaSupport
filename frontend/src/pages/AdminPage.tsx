import { useState, useEffect, useCallback } from 'react'
// import { useNavigate } from 'react-router-dom'
import { FileText, Upload, RefreshCw } from 'lucide-react'
import { listFiles, uploadPdf, type UploadedFile } from '../api/upload'
import { useAuth } from '../context/AuthContext'
import { AdminHeader } from '../components/adminHeader'

export function AdminPage() {

  const { user } = useAuth()
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const loadFiles = useCallback(async () => {
    setIsLoadingFiles(true)
    setError('')
    try {
      const data = await listFiles()
      setFiles(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files')
    } finally {
      setIsLoadingFiles(false)
    }
  }, [])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.type !== 'application/pdf') {
      setError('Only PDF files are supported')
      return
    }

    setIsUploading(true)
    setError('')
    setSuccess('')

    try {
      const message = await uploadPdf(file)
      setSuccess(message)
      await loadFiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

 
  const initials = user?.email?.slice(0, 2).toUpperCase() ?? 'AD'

  return (
    <div className="flex min-h-full flex-col bg-background">
      <AdminHeader />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-8 md:px-6">
        <div className="mb-6 sm:mb-8">
          <h1 className="font-ui text-xl sm:text-2xl font-medium text-text-primary">
            Knowledge base
          </h1>
          <p className="mt-1 font-ui text-sm text-text-secondary">
            Manage PDF documents used by the support chatbot
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

        <section className="mb-6 sm:mb-8 rounded-xl border border-border bg-surface p-4 sm:p-6">
          <div className="mb-4 flex items-center gap-2">
            <Upload className="h-5 w-5 shrink-0 text-accent" strokeWidth={2} />
            <h2 className="font-ui text-base font-medium text-text-primary">
              Upload PDF
            </h2>
          </div>
          <p className="mb-4 font-ui text-sm text-text-secondary">
            Add a new document to the knowledge base. Files are parsed, chunked,
            and embedded for RAG search.
          </p>
          <label
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-surface-muted px-4 py-8 sm:px-6 sm:py-10 text-center transition-all duration-150 hover:border-accent hover:bg-accent-light/50 ${
              isUploading ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            <Upload className="mb-3 h-8 w-8 text-text-hint" strokeWidth={1.5} />
            <span className="font-ui text-sm font-medium text-text-primary">
              {isUploading ? 'Uploading and processing…' : 'Click to upload PDF'}
            </span>
            <span className="mt-1 font-ui text-xs text-text-hint">
              PDF files only
            </span>
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleUpload}
              disabled={isUploading}
            />
          </label>
        </section>

        <section className="rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-5 w-5 shrink-0 text-accent" strokeWidth={2} />
              <h2 className="truncate font-ui text-base font-medium text-text-primary">
                Current files
              </h2>
            </div>
            <button
              type="button"
              onClick={loadFiles}
              disabled={isLoadingFiles}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 font-ui text-xs text-text-secondary transition-all duration-150 hover:bg-accent-light hover:text-accent disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>

          {isLoadingFiles ? (
            <div className="px-4 py-10 text-center font-ui text-sm text-text-hint sm:px-6">
              Loading files…
            </div>
          ) : files.length === 0 ? (
            <div className="px-4 py-10 text-center sm:px-6">
              <FileText
                className="mx-auto mb-3 h-10 w-10 text-text-hint"
                strokeWidth={1.5}
              />
              <p className="font-ui text-sm text-text-secondary">
                No documents uploaded yet
              </p>
              <p className="mt-1 font-ui text-xs text-text-hint">
                Upload a PDF above to get started
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {files.map((file) => (
                <li
                  key={file.documentId}
                  className="flex items-center gap-3 px-4 py-4 transition-all duration-150 hover:bg-sidebar-hover sm:gap-4 sm:px-6"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-light sm:h-10 sm:w-10">
                    <FileText className="h-4.5 w-4.5 text-accent sm:h-5 sm:w-5" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-ui text-sm font-medium text-text-primary">
                      {file.filename}
                    </p>
                    <p className="truncate font-ui text-xs text-text-hint">
                      {file.chunkCount} chunks · ID {file.documentId.slice(0, 8)}…
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
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