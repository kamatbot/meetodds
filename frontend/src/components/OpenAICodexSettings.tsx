'use client';

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Copy, ExternalLink, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';

interface CodexAuthStatus {
  loggedIn: boolean;
  accountId?: string | null;
}

interface CodexDeviceAuthStart {
  userCode: string;
  deviceAuthId: string;
  verificationUrl: string;
  intervalSeconds: number;
}

interface CodexDeviceAuthPoll {
  status: 'pending' | 'connected';
  accountId?: string | null;
}

interface CodexModel {
  id: string;
}

interface OpenAICodexSettingsProps {
  onConnectionChange: (connected: boolean) => void;
  onModelsChange: (models: string[]) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function OpenAICodexSettings({
  onConnectionChange,
  onModelsChange,
}: OpenAICodexSettingsProps) {
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<CodexAuthStatus>({ loggedIn: false });
  const [deviceAuth, setDeviceAuth] = useState<CodexDeviceAuthStart | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadModels = async () => {
    try {
      const models = await invoke<CodexModel[]>('openai_codex_get_models');
      if (mountedRef.current) {
        onModelsChange(models.map((model) => model.id));
      }
    } catch (error) {
      console.error('Failed to load ChatGPT/Codex models:', error);
      if (mountedRef.current) onModelsChange([]);
    }
  };

  const refreshStatus = async () => {
    setIsChecking(true);
    try {
      const next = await invoke<CodexAuthStatus>('openai_codex_get_auth_status');
      if (!mountedRef.current) return;
      setStatus(next);
      onConnectionChange(next.loggedIn);
      if (next.loggedIn) {
        await loadModels();
      } else {
        onModelsChange([]);
      }
    } catch (error) {
      console.error('Failed to check ChatGPT/Codex auth status:', error);
      if (!mountedRef.current) return;
      setStatus({ loggedIn: false });
      onConnectionChange(false);
      onModelsChange([]);
    } finally {
      if (mountedRef.current) setIsChecking(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
    // Callbacks are intentionally omitted: they are setters from the parent and
    // including them would restart auth checks on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startSignIn = async () => {
    setIsSigningIn(true);
    setDeviceAuth(null);
    try {
      const start = await invoke<CodexDeviceAuthStart>('openai_codex_start_device_auth');
      if (!mountedRef.current) return;
      setDeviceAuth(start);

      await invoke('open_external_url', { url: start.verificationUrl });
      toast.info('Finish signing in with ChatGPT in your browser', {
        description: `Enter code ${start.userCode} if OpenAI asks for it.`,
        duration: 10000,
      });

      const deadline = Date.now() + 15 * 60 * 1000;
      const intervalMs = Math.max(start.intervalSeconds, 3) * 1000;

      while (mountedRef.current && Date.now() < deadline) {
        await sleep(intervalMs);
        if (!mountedRef.current) return;

        const result = await invoke<CodexDeviceAuthPoll>('openai_codex_poll_device_auth', {
          deviceAuthId: start.deviceAuthId,
          userCode: start.userCode,
        });

        if (result.status === 'connected') {
          const connected = {
            loggedIn: true,
            accountId: result.accountId ?? null,
          };
          setStatus(connected);
          setDeviceAuth(null);
          onConnectionChange(true);
          await loadModels();
          toast.success('ChatGPT subscription connected to MeetOdds');
          return;
        }
      }

      if (mountedRef.current) {
        throw new Error('ChatGPT sign-in timed out. Start the sign-in again.');
      }
    } catch (error) {
      console.error('ChatGPT/Codex sign-in failed:', error);
      if (mountedRef.current) {
        toast.error('Could not connect ChatGPT subscription', {
          description: String(error),
        });
      }
    } finally {
      if (mountedRef.current) setIsSigningIn(false);
    }
  };

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await invoke('openai_codex_logout');
      if (!mountedRef.current) return;
      setStatus({ loggedIn: false });
      setDeviceAuth(null);
      onConnectionChange(false);
      onModelsChange([]);
      toast.success('ChatGPT subscription disconnected');
    } catch (error) {
      toast.error('Could not disconnect ChatGPT subscription', {
        description: String(error),
      });
    } finally {
      if (mountedRef.current) setIsSigningOut(false);
    }
  };

  const copyCode = async () => {
    if (!deviceAuth?.userCode) return;
    try {
      await navigator.clipboard.writeText(deviceAuth.userCode);
      toast.success('Sign-in code copied');
    } catch {
      toast.error('Could not copy sign-in code');
    }
  };

  return (
    <Alert className="border-emerald-200 bg-emerald-50">
      <AlertDescription className="space-y-3 text-sm text-emerald-950">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="font-semibold">OpenAI Codex — use your ChatGPT subscription</p>
            <p className="text-xs text-emerald-900/80">
              Connects through OpenAI&apos;s Codex device-code OAuth flow. No OpenAI API key is needed;
              usage counts against the Codex allowance available to your ChatGPT account.
            </p>
          </div>
          {status.loggedIn && <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-700" />}
        </div>

        {isChecking ? (
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking ChatGPT connection…
          </div>
        ) : status.loggedIn ? (
          <div className="space-y-2">
            <p className="text-xs">
              Connected{status.accountId ? ` • account ${status.accountId}` : ''}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={signOut}
              disabled={isSigningOut}
            >
              {isSigningOut ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="mr-2 h-3.5 w-3.5" />
              )}
              Disconnect ChatGPT
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Button
              type="button"
              size="sm"
              onClick={startSignIn}
              disabled={isSigningIn}
            >
              {isSigningIn ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
              )}
              {isSigningIn ? 'Waiting for ChatGPT…' : 'Sign in with ChatGPT'}
            </Button>

            {deviceAuth && (
              <div className="rounded-md border border-emerald-200 bg-white/70 p-3">
                <p className="text-xs text-muted-foreground">OpenAI sign-in code</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="text-base font-semibold tracking-wider">{deviceAuth.userCode}</code>
                  <Button type="button" variant="ghost" size="icon" onClick={copyCode}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  The browser should already be open. Enter this code if prompted.
                </p>
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] text-emerald-900/70">
          MeetOdds keeps its own OAuth session and does not read or overwrite Codex CLI credentials.
        </p>
      </AlertDescription>
    </Alert>
  );
}
