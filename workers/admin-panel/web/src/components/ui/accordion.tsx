import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { ChevronDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Base UI Accordion 的 shadcn 封装。
 *
 * 展开收合动画用 accordion-panel 工具类（index.css）：keyframes 读 Panel 自带的
 * --accordion-panel-height 变量，高度未知也能过渡。
 */

function Accordion({ ...props }: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('rounded-xl border bg-card', className)}
      {...props}
    />
  );
}

function AccordionHeader({ className, ...props }: AccordionPrimitive.Header.Props) {
  return (
    <AccordionPrimitive.Header data-slot="accordion-header" className={className} {...props} />
  );
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Trigger
      data-slot="accordion-trigger"
      className={cn(
        'flex flex-1 items-center gap-2 py-3 text-left text-sm font-medium outline-none focus-visible:ring-2',
        '[&[data-panel-open]>svg]:rotate-180',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon
        aria-hidden
        className="text-muted-foreground size-4 shrink-0 transition-transform duration-200"
      />
    </AccordionPrimitive.Trigger>
  );
}

function AccordionContent({
  className,
  children,
  keepMounted = true,
  ...props
}: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      keepMounted={keepMounted}
      className={cn('accordion-panel', className)}
      {...props}
    >
      <div className="pb-3">{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionHeader, AccordionTrigger, AccordionContent };
