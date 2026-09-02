import React, { useState, useEffect } from "react";
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import Image from 'next/image';
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch";
import { UpdateDialog } from "./UpdateDialog";
import { updateService, UpdateInfo } from '@/services/updateService';
import { Button } from './ui/button';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

export function About() {
    const [currentVersion, setCurrentVersion] = useState<string>('0.4.0');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [showUpdateDialog, setShowUpdateDialog] = useState(false);

    useEffect(() => {
        getVersion().then(setCurrentVersion).catch(console.error);
    }, []);

    const handleProjectClick = async () => {
        try {
            await invoke('open_external_url', { url: 'https://github.com/kamatbot/notes' });
        } catch (error) {
            console.error('Failed to open link:', error);
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
        } catch (error: any) {
            console.error('Failed to check for updates:', error);
            toast.error('Failed to check for updates: ' + (error.message || 'Unknown error'));
        } finally {
            setIsChecking(false);
        }
    };

    return (
        <div className="p-4 space-y-4 h-[80vh] overflow-y-auto">
            <div className="text-center">
                <div className="mb-3">
                    <Image
                        src="icon_128x128.png"
                        alt="MeetOdds logo"
                        width={64}
                        height={64}
                        className="mx-auto"
                    />
                </div>
                <h1 className="text-xl font-bold text-gray-900">MeetOdds</h1>
                <span className="text-sm text-gray-500"> v{currentVersion}</span>
                <p className="text-medium text-gray-600 mt-1">
                    Local-first meeting notes and transcription, with optional cloud AI summaries.
                </p>
                <div className="mt-3">
                    <Button
                        onClick={handleCheckForUpdates}
                        disabled={isChecking}
                        variant="outline"
                        size="sm"
                        className="text-xs"
                    >
                        {isChecking ? (
                            <>
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                Checking...
                            </>
                        ) : (
                            <>
                                <CheckCircle2 className="h-3 w-3 mr-2" />
                                Check for Updates
                            </>
                        )}
                    </Button>
                    {updateInfo?.available && (
                        <div className="mt-2 text-xs text-blue-600">
                            Update available: v{updateInfo.version}
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-3">
                <h2 className="text-base font-semibold text-gray-800">What makes MeetOdds different</h2>
                <div className="grid grid-cols-2 gap-2">
                    <div className="bg-gray-50 rounded p-3 hover:bg-gray-100 transition-colors">
                        <h3 className="font-bold text-sm text-gray-900 mb-1">Local-first</h3>
                        <p className="text-xs text-gray-600 leading-relaxed">Recordings and transcripts stay local. If you choose a cloud LLM, MeetOdds sends only the summary request content to that provider.</p>
                    </div>
                    <div className="bg-gray-50 rounded p-3 hover:bg-gray-100 transition-colors">
                        <h3 className="font-bold text-sm text-gray-900 mb-1">Use Any Model</h3>
                        <p className="text-xs text-gray-600 leading-relaxed">Use built-in or Ollama models offline, OpenAI in the cloud, or another supported provider. No model lock-in.</p>
                    </div>
                    <div className="bg-gray-50 rounded p-3 hover:bg-gray-100 transition-colors">
                        <h3 className="font-bold text-sm text-gray-900 mb-1">Cost-Smart</h3>
                        <p className="text-xs text-gray-600 leading-relaxed">Run locally for no per-call LLM fees, or use cloud APIs only when you choose.</p>
                    </div>
                    <div className="bg-gray-50 rounded p-3 hover:bg-gray-100 transition-colors">
                        <h3 className="font-bold text-sm text-gray-900 mb-1">Works everywhere</h3>
                        <p className="text-xs text-gray-600 leading-relaxed">Google Meet, Zoom, Teams, online or offline.</p>
                    </div>
                </div>
            </div>

            <div className="bg-blue-50 rounded p-3">
                <p className="text-s text-blue-800">
                    <span className="font-bold">MeetOdds:</span> capture the conversation locally, then choose the intelligence layer that fits the meeting.
                </p>
            </div>

            <div className="text-center space-y-2">
                <h3 className="text-medium font-semibold text-gray-800">Local when you want it. Cloud when it helps.</h3>
                <p className="text-s text-gray-600">
                    MeetOdds keeps transcription local by default while letting you opt into stronger cloud models for summaries and analysis.
                </p>
                <button
                    onClick={handleProjectClick}
                    className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded transition-colors duration-200 shadow-sm hover:shadow-md"
                >
                    View MeetOdds on GitHub
                </button>
            </div>

            <div className="pt-2 border-t border-gray-200 text-center">
                <p className="text-xs text-gray-400">
                    MeetOdds • based on the open-source Meetily project
                </p>
            </div>
            <AnalyticsConsentSwitch />

            <UpdateDialog
                open={showUpdateDialog}
                onOpenChange={setShowUpdateDialog}
                updateInfo={updateInfo}
            />
        </div>
    )
}
