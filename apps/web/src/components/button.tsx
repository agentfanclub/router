import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "default" | "illinois" | "destructive";
  arrow?: boolean;
  loading?: boolean;
};

export function Button({ children, variant = "default", arrow = false, loading = false, disabled, className = "", type = "button", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cn(
        "inline-grid cursor-pointer items-center justify-center rounded-[7px] text-white transition-[transform,box-shadow,filter] duration-[120ms] ease-[ease] enabled:hover:brightness-115 enabled:active:translate-y-px disabled:cursor-default disabled:not-aria-busy:opacity-50 motion-reduce:transition-none",
        variant === "illinois"
          ? "min-h-11 border-0 bg-[#0085ff] px-4 py-2.5 text-sm font-medium antialiased shadow-none"
          : "min-h-[30px] border border-transparent bg-[linear-gradient(180deg,#626262_0%,#484848_8%,#292929_24%,#171717_65%,#141414_100%)] px-3 py-[5px] text-xs font-normal leading-[18px] shadow-[0_2px_4px_rgb(0_0_0_/_18%)] enabled:active:shadow-[0_1px_2px_rgb(0_0_0_/_14%)]",
        variant === "destructive" && "bg-[linear-gradient(180deg,#f08080_0%,#e25454_8%,#cc3030_24%,#b91c1c_65%,#a71919_100%)]",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      <span className={cn("col-start-1 row-start-1 inline-flex items-center justify-center", variant === "illinois" ? "gap-3" : "gap-2", loading && "opacity-0")}>
        {children}
        {arrow && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12h16m-6-6 6 6-6 6" />
          </svg>
        )}
      </span>
      {loading && <span className="col-start-1 row-start-1 size-3.5 animate-spin justify-self-center rounded-full border-[1.5px] border-white/30 border-t-current [animation-duration:700ms] motion-reduce:animate-none" aria-hidden="true" />}
    </button>
  );
}
