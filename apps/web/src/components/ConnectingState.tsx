import { Link } from "@tanstack/react-router";

import { isElectron } from "../env";
import type { ConnectingView } from "./ConnectingState.logic";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function ConnectingState({ view }: { readonly view: ConnectingView }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <ConnectingStateContent view={view} />
    </SidebarInset>
  );
}

export function ConnectingStateContent({
  view,
  draft = false,
}: {
  readonly view: ConnectingView;
  readonly draft?: boolean;
}) {
  return (
    <div
      data-draft-hero={draft ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      {view.kind === "unreachable" ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>Can’t reach {view.label}</EmptyTitle>
            <EmptyDescription>
              {view.error ?? "Check that T3 Code is running on that computer."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/settings/connections" />} size="sm" variant="outline">
              Open Connections
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-1 items-center justify-center" role="status">
          <img src="/apple-touch-icon.png" alt="T3 Code" className="size-16 object-contain" />
        </div>
      )}
    </div>
  );
}
