import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils";

// Shared skeleton for the dashboard's grid-based tables. The frame, row
// styling, and column tracks live in styles.css; callers pick a `variant`
// that supplies the matching grid-template-columns class and author their own
// <tr>/<td> cells.
type TableVariant =
  | "api-keys"
  | "leaderboard"
  | "logs"
  | "models"
  | "models-usage"
  | "users";

const variantClass: Record<TableVariant, string> = {
  "api-keys": "api-keys-table",
  leaderboard: "leaderboard-table",
  logs: "logs-table",
  models: "models-table",
  "models-usage": "models-usage-table",
  users: "users-table",
};

interface DataTableProps {
  variant: TableVariant;
  // Readable description of the table's contents, announced to screen readers.
  caption: string;
  // Minimum table width in pixels before the frame scrolls horizontally.
  minWidth: number;
  children: ReactNode;
  className?: string;
}

export function DataTable({ variant, caption, minWidth, children, className }: DataTableProps) {
  return (
    <div className={cn("dashboard-table-frame max-w-[960px] overflow-x-auto bg-[#eeeeee]", className)}>
      <table
        className={cn(
          "dashboard-table w-full border-separate border-spacing-0 text-left text-sm text-neutral-600",
          variantClass[variant],
        )}
        style={{ minWidth }}
      >
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="text-sm text-neutral-500">{children}</tr>
    </thead>
  );
}

type Align = "left" | "right";

interface CellProps {
  align?: Align;
  // Outer horizontal padding: `outer` columns line up with the frame edge.
  pad?: "inner" | "start" | "end";
}

export function Th({ align = "left", pad = "inner", className, ...props }: ComponentProps<"th"> & CellProps) {
  return (
    <th
      scope="col"
      className={cn("whitespace-nowrap py-2.5 font-medium", horizontalPad(pad), align === "right" && "text-right", className)}
      {...props}
    />
  );
}

export function Td({ align = "left", pad = "inner", className, ...props }: ComponentProps<"td"> & CellProps) {
  return (
    <td
      className={cn("py-3", horizontalPad(pad), align === "right" && "text-right", className)}
      {...props}
    />
  );
}

function horizontalPad(pad: NonNullable<CellProps["pad"]>): string {
  switch (pad) {
    case "start": return "pl-5 pr-3";
    case "end": return "pl-3 pr-5";
    default: return "px-3";
  }
}

interface TableBodyProps<T> {
  rows: readonly T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string | undefined;
  renderRow: (row: T, index: number) => ReactNode;
  // Column count for the empty-state row. Must match the header's columns.
  columns: number;
  empty?: ReactNode;
}

export function TableBody<T>({ rows, rowKey, rowClassName, renderRow, columns, empty }: TableBodyProps<T>) {
  return (
    <tbody className="bg-white" data-single-row={rows.length === 1 ? "true" : undefined}>
      {rows.map((row, index) => (
        <tr key={rowKey(row)} className={rowClassName?.(row)}>
          {renderRow(row, index)}
        </tr>
      ))}
      {rows.length === 0 && (
        <tr>
          <td colSpan={columns} className="px-6 py-8 text-center text-neutral-500">
            {empty ?? "Nothing here yet."}
          </td>
        </tr>
      )}
    </tbody>
  );
}
