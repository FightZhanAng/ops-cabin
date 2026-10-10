import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/** 状态贴片：与仪表灯同一套语义色（ok / warn / destructive 对应绿 / 黄 / 红） */
const badgeVariants = cva(
  "inline-flex h-[19px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[3px] border px-1.5 text-[11px] font-medium leading-none whitespace-nowrap transition-colors duration-150 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-btn text-btn-fg",
        secondary: "border-line bg-panel-2 text-dim",
        outline: "border-line-2 bg-panel-2 text-dim",
        ok: "chip-ok",
        warn: "chip-warn",
        destructive: "chip-danger",
        ghost: "border-transparent text-dim hover:bg-panel-2",
        link: "border-transparent text-fg underline decoration-line-2 underline-offset-4 hover:decoration-fg",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
