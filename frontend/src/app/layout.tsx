'use client'

import './globals.css'
import { Source_Sans_3 } from 'next/font/google'
import { usePathname } from 'next/navigation'
import { SidebarProvider } from '@/components/Sidebar/SidebarProvider'
import AppShell from '@/components/AppShell/AppShell'
import NotesNavigationBridge from '@/components/Notes/NotesNavigationBridge'
import AnalyticsProvider from '@/components/AnalyticsProvider'
import { Toaster, toast } from 'sonner'
import "sonner/dist/styles.css"
import { useState, useEffect, useCallback } from 'react'
import { listen, UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RecordingStateProvider } from '@/contexts/RecordingStateContext'
import { OllamaDownloadProvider } from '@/contexts/OllamaDownloadContext'
import { TranscriptProvider } from '@/contexts/TranscriptContext'
import { ConfigProvider } from '@/contexts/ConfigContext'
import { OnboardingProvider } from '@/contexts/OnboardingContext'
import { OnboardingFlow } from '@/components/onboarding'
import { DownloadProgressToastProvider } from '@/components/shared/DownloadProgressToast'
import { RecordingPostProcessingProvider } from '@/contexts/RecordingPostProcessingProvider'
import { ImportAudioDialog, ImportDropOverlay } from '@/components/ImportAudio'
import { ImportDialogProvider } from '@/contexts/ImportDialogContext'
import { isAudioExtension, getAudioFormatsDisplayList } from '@/constants/audioFormats'
import { LiveMeetingTranslationProvider } from '@/contexts/LiveMeetingTranslationContext'
import LiveCaptionBridge from '@/components/Captions/LiveCaptionBridge'

const sourceSans3 = Source_Sans_3({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-source-sans-3' })

function ConditionalImportDialog({ showImportDialog, handleImportDialogClose, importFilePath }: { showImportDialog: boolean; handleImportDialogClose: (open: boolean) => void; importFilePath: string | null }) {
  return <ImportAudioDialog open={showImportDialog} onOpenChange={handleImportDialogClose} preselectedFile={importFilePath} />
}

function MainAppLayout({ children }: { children: React.ReactNode }) {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [showDropOverlay, setShowDropOverlay] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importFilePath, setImportFilePath] = useState<string | null>(null)

  useEffect(() => {
    invoke<{ completed: boolean } | null>('get_onboarding_status')
      .then((status) => setShowOnboarding(!(status?.completed ?? false)))
      .catch((error) => {
        console.error('[Layout] Failed to check onboarding status:', error)
        setShowOnboarding(true)
      })
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') {
      const handleContextMenu = (event: MouseEvent) => event.preventDefault()
      document.addEventListener('contextmenu', handleContextMenu)
      return () => document.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [])

  useEffect(() => {
    const unlisten = listen('request-recording-toggle', () => {
      if (showOnboarding) {
        toast.error('Please complete setup first', { description: 'Finish onboarding before starting a recording.' })
      } else {
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'))
      }
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [showOnboarding])

  const handleFileDrop = useCallback((paths: string[]) => {
    const audioFile = paths.find((path) => {
      const extension = path.split('.').pop()?.toLowerCase()
      return Boolean(extension && isAudioExtension(extension))
    })
    if (audioFile) {
      setImportFilePath(audioFile)
      setShowImportDialog(true)
    } else if (paths.length > 0) {
      toast.error('Please drop an audio file', { description: `Supported formats: ${getAudioFormatsDisplayList()}` })
    }
  }, [])

  useEffect(() => {
    if (showOnboarding) return
    const unlisteners: UnlistenFn[] = []
    const cleanedUpRef = { current: false }
    const setupListeners = async () => {
      const add = (unlisten: UnlistenFn) => {
        if (cleanedUpRef.current) unlisten()
        else unlisteners.push(unlisten)
      }
      add(await listen('tauri://drag-enter', () => setShowDropOverlay(true)))
      add(await listen('tauri://drag-leave', () => setShowDropOverlay(false)))
      add(await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        setShowDropOverlay(false)
        handleFileDrop(event.payload.paths)
      }))
    }
    void setupListeners()
    return () => {
      cleanedUpRef.current = true
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [showOnboarding, handleFileDrop])

  const handleImportDialogClose = useCallback((open: boolean) => {
    setShowImportDialog(open)
    if (!open) setImportFilePath(null)
  }, [])
  const handleOpenImportDialog = useCallback((filePath?: string | null) => {
    setImportFilePath(filePath ?? null)
    setShowImportDialog(true)
  }, [])
  const handleOnboardingComplete = useCallback(() => setShowOnboarding(false), [])

  return (
    <html lang="en">
      <body className={`${sourceSans3.variable} font-sans antialiased`}>
        <AnalyticsProvider>
          <RecordingStateProvider>
            <TranscriptProvider>
              <ConfigProvider>
                <LiveMeetingTranslationProvider>
                <LiveCaptionBridge />
                <OllamaDownloadProvider>
                  <OnboardingProvider>
                    <SidebarProvider>
                      <TooltipProvider>
                        <RecordingPostProcessingProvider>
                          <ImportDialogProvider onOpen={handleOpenImportDialog}>
                            <NotesNavigationBridge />
                            <DownloadProgressToastProvider />
                            {showOnboarding ? <OnboardingFlow onComplete={handleOnboardingComplete} /> : <AppShell>{children}</AppShell>}
                            <ImportDropOverlay visible={showDropOverlay} />
                            <ConditionalImportDialog showImportDialog={showImportDialog} handleImportDialogClose={handleImportDialogClose} importFilePath={importFilePath} />
                          </ImportDialogProvider>
                        </RecordingPostProcessingProvider>
                      </TooltipProvider>
                    </SidebarProvider>
                  </OnboardingProvider>
                </OllamaDownloadProvider>
                </LiveMeetingTranslationProvider>
              </ConfigProvider>
            </TranscriptProvider>
          </RecordingStateProvider>
        </AnalyticsProvider>
        <Toaster position="bottom-center" richColors closeButton />
      </body>
    </html>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  // This display-only route must not mount recorder, recovery, onboarding or AI providers.
  if (pathname === '/live-captions' || pathname === '/live-captions/') {
    return (
      <html lang="en" className={`${sourceSans3.variable} caption-root`} style={{ background: 'transparent' }}>
        <body style={{ margin: 0, background: 'transparent', overflow: 'hidden' }}>{children}</body>
      </html>
    )
  }
  if (pathname === '/manual-notes') {
    return (
      <html lang="en" className={sourceSans3.variable}>
        <body className="h-screen w-screen overflow-hidden bg-bg text-text">{children}</body>
      </html>
    )
  }
  return <MainAppLayout>{children}</MainAppLayout>
}
