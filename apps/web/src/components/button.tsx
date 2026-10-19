import type { ComponentProps } from "react";

type ButtonProps = ComponentProps<"button"> & {
  arrow?: boolean;
  loading?: boolean;
};

export function Button({ children, arrow = false, loading = false, disabled, className = "", type = "button", ...props }: ButtonProps) {
  return (
    <button {...props} type={type} className={`button-gloss ${className}`} disabled={disabled || loading} aria-busy={loading}>
      <span className="button-gloss-content">
        {children}
        {arrow && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 12h16m-6-6 6 6-6 6" />
          </svg>
        )}
      </span>
      {loading && <span className="button-gloss-spinner" aria-hidden="true" />}
    </button>
  );
}
