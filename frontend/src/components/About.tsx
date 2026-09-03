'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { UpdateDialog } from './UpdateDialog';
import { updateService, type UpdateInfo } from '@/services/updateService';
import SettingRow from '@/components/Settings/SettingRow';

export function About() {
  const [currentVersion, setCurrentVersion] = useState('0.4.0');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);

  useEffect(() => {
    void getVersion().then(setCurrentVersion).catch(console.error);
  }, []);

  const handleProjectClick = async () => {
    try {
      await invoke('open_external_url', { url: 'https://github.com/kamatbot/notes' });
    } catch (error) {
      console.error('Failed to open project link:', error);
      toast.error('Could not open project page');
    }
  };

  const handleCheckForUpdates = async () => {
    setIsChecking(true);
    try {
      const info = await updateService.checkForUpdates(true);
      setUpdateInfo(info);
      if (info.available) {
        setShowUpdateDialog(true);
      } else {
        toast.success('You are running the latest version');
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
      toast.error('Failed to check for updates', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-4 border-b border-border pb-5">
        <Image
          src="icon_128x128.png"
          alt="MeetOdds logo"
          width={56}
          height={56}
          className="shrink-0"
        />
        <div className="min-w-0">
          <div className="text-title text-text">MeetOdds</div>
          <div className="mt-0.5 text-caption text-3">Version {currentVersion}</div>
          <p className="mt-1 text-ui leading-5 text-2">
            Local-first meeting capture and transcription with an AI layer you choose.
          </p>
        </div>
      </div>

      <SettingRow
        label="Software updates"
        description={updateInfo?.available
          ? `Version ${updateInfo.version} is available.`
          : 'Check GitHub releases for a newer MeetOdds build.'}
        control={(
          <button
            type="button"
            onClick={() => void handleCheckForUpdates()}
            disabled={isChecking}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text hover:bg-surface disabled:opacity-40"
          >
            {isChecking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Check now
          </button>
        )}
      />

      <SettingRow
        label="Project"
        description="MeetOdds is based on the open-source Meetily project and keeps local capture as the default."
        control={(
          <button
            type="button"
            onClick={() => void handleProjectClick()}
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text hover:bg-surface"
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} /> GitHub
          </button>
        )}
      />

      <div className="py-4 text-caption leading-5 text-3">
        Recordings and transcripts stay local. Cloud providers receive meeting content only when you explicitly use cloud-backed AI features.
      </div>

      <UpdateDialog
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
        updateInfo={updateInfo}
      />
    </div>
  );
}
