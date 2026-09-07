'use client';

import ActionInboxPanel from '@/components/Actions/ActionInboxPanel';

export default function ActionsPage() {
  return (
    <main className="h-full overflow-y-auto bg-bg custom-scrollbar">
      <div className="mx-auto w-full max-w-[880px] px-6 py-8 md:py-10">
        <ActionInboxPanel limit={100} />
      </div>
    </main>
  );
}
