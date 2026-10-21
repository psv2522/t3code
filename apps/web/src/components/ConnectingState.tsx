import { Link } from "@tanstack/react-router";

import { isElectron } from "../env";
import type { ConnectingView } from "./ConnectingState.logic";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { Spinner } from "./ui/spinner";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function ConnectingState({ view }: { readonly view: ConnectingView }) {
  const unreachable = view.kind === "unreachable";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty className="flex-1">
          <EmptyHeader>
            {unreachable ? null : (
              <EmptyMedia>
                <Spinner size="lg" tone="muted" />
              </EmptyMedia>
            )}
            <EmptyTitle>
              {view.kind === "connecting"
                ? view.label === null
                  ? "Connecting"
                  : `Connecting to ${view.label}`
                : unreachable
                  ? `Can’t reach ${view.label}`
                  : "Loading workspace"}
            </EmptyTitle>
            {view.kind === "connecting" ? (
              <EmptyDescription>Your threads open as soon as the server responds.</EmptyDescription>
            ) : unreachable ? (
              <EmptyDescription>
                {view.error ?? "Check that T3 Code is running on that computer."}
              </EmptyDescription>
            ) : null}
          </EmptyHeader>
          {unreachable ? (
            <EmptyContent>
              <Button render={<Link to="/settings/connections" />} size="sm" variant="outline">
                Open Connections
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </div>
    </SidebarInset>
  );
}
