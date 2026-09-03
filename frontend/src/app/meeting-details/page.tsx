'use client';

import { Suspense, useEffect } from 'react';
import { LoaderIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

function RedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.toString();

  useEffect(() => {
    router.replace(query ? `/meeting?${query}` : '/meeting');
  }, [query, router]);

  return <RedirectFallback />;
}

function RedirectFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-3">
      <LoaderIcon className="h-5 w-5 animate-spin" />
      <span className="ml-2 text-ui">Opening meeting…</span>
    </div>
  );
}

export default function MeetingDetailsRedirect() {
  return (
    <Suspense fallback={<RedirectFallback />}>
      <RedirectContent />
    </Suspense>
  );
}
