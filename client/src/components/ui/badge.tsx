import type { HTMLAttributes } from "react";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "border-cyan-400/30 bg-cyan-500/15 text-cyan-100",
  secondary: "border-slate-700 bg-slate-800 text-slate-200",
  destructive: "border-rose-500/30 bg-rose-500/15 text-rose-100",
  outline: "border-slate-700 bg-transparent text-slate-300",
};

export function Badge({
  className,
  children,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-wide",
        variantClasses[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
