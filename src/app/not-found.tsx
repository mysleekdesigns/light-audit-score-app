import Link from "next/link";
import { Compass, Home } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

// 404 surface. Rendered inside the root layout's <main>, on-brand with a
// route back to the Lighthouse console.
export default function NotFound() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2 border-b border-border/60 pb-6">
        <span className="font-mono text-xs uppercase tracking-[0.32em] text-primary">
          404 — Off the map
        </span>
      </div>

      <Empty className="border border-border/60 bg-card/40 py-14">
        <EmptyHeader>
          <EmptyMedia
            variant="icon"
            className="size-10 [&_svg:not([class*='size-'])]:size-5"
          >
            <Compass aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            There&apos;s no instrument at this address. The page may have moved,
            or the link was mistyped.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href="/">
              <Home aria-hidden="true" />
              Back to Lighthouse
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
