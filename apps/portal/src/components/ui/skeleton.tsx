import { cn } from "@/lib/utils"

/** A pulsing placeholder block. Compose several to mimic the shape of the
 *  content that's loading (rows, cards, a document) so the swap-in is shift-free. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
