import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/**
 * 按钮 = 动作（石墨墨阶），颜色留给状态。
 * 唯一例外是 destructive：不可逆动作（永久删除、结束进程、重置）才用红。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-btn text-btn-fg hover:bg-btn-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-[var(--btn-danger-hover)]",
        outline: "border border-line-2 bg-panel text-fg hover:bg-panel-2",
        secondary: "border border-line bg-panel-2 text-fg hover:border-line-2",
        ghost: "text-fg hover:bg-panel-2",
        link: "text-fg underline decoration-line-2 underline-offset-4 hover:decoration-fg",
      },
      size: {
        default: "h-8 px-3.5 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-[11.5px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-[12.5px] has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-5",
        icon: "size-8",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
