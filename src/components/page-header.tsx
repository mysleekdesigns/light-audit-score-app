import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /** Monospace index/eyebrow, e.g. "01 — Input". */
  kicker: string;
  title: string;
  description?: string;
  className?: string;
  children?: React.ReactNode;
}

export function PageHeader({
  kicker,
  title,
  description,
  className,
  children,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 border-b border-border/60 pb-6 md:flex-row md:items-end md:justify-between",
        className
      )}
    >
      <div className="flex flex-col gap-2">
        <span className="font-mono text-xs uppercase tracking-[0.32em] text-primary">
          {kicker}
        </span>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children ? <div className="flex items-center gap-3">{children}</div> : null}
    </div>
  );
}
