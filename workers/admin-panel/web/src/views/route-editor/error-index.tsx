/**
 * The global error index in the action bar.
 *
 * A disabled save button says "no" without saying why, and most validation errors
 * live inside collapsed cards where nobody will find them. This turns the count
 * into a list, and every row into a jump: expand the card that holds the field,
 * then move focus onto the field itself.
 *
 * It renders nothing when the draft is clean — an empty popover trigger sitting in
 * the bar would be a permanent reminder of a problem that does not exist.
 */
import * as React from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/messages';
import { GUARDS_ITEMS } from './constants';
import type { FieldErrors } from './constants';
import { ERROR_TARGETS } from './errors';
import type { RouteDraft } from './use-route-draft';

/**
 * 手风琴展开到聚焦之间要等一拍：Base UI 的 AccordionContent 收起时高度为 0，
 * 立刻 focus 会落在一个不可见元素上（浏览器不滚，人以为按钮坏了）。
 * 150ms 覆盖 nova 的展开过渡，比 rAF 稳。
 */
const EXPAND_SETTLE_MS = 150;

/**
 * 清单的标题已经是字段名，描述不必再复读一遍。
 *
 * collectErrors 的每条文案都以字段名开头 —— 那是给「保存被拦」的一句话摘要留的，
 * 它必须能单独成句。这里有标题承担同一件事，所以把前缀剥掉，两行各说一半。
 */
const stripLabel = (message: string, label: string): string =>
  message.startsWith(label) ? message.slice(label.length).replace(/^[：:\s]+/u, '') : message;

export const ErrorIndex = ({ draft }: { readonly draft: RouteDraft }) => {
  const [open, setOpen] = React.useState(false);
  const entries = Object.entries(draft.shownErrors) as readonly [keyof FieldErrors, string][];

  if (entries.length === 0) {
    return null;
  }

  const jump = (key: keyof FieldErrors) => {
    const target = ERROR_TARGETS[key];
    setOpen(false);
    // 错误全在表单字段上：人在 JSON 页时先把视图换回去，否则跳到一个没渲染的框。
    draft.handleTabChange('form');
    if (target.card !== undefined) {
      const card = target.card;
      const isGuard = (GUARDS_ITEMS as readonly string[]).includes(card);
      const expand = (prev: string[]) => (prev.includes(card) ? prev : [...prev, card]);
      if (isGuard) {
        draft.setGuardsOpen(expand);
      } else {
        draft.setAdvancedOpen(expand);
      }
    }
    window.setTimeout(() => {
      const element = document.getElementById(target.fieldId);
      if (element === null) {
        return;
      }
      // 容器锚点（条件编辑器）本身不可聚焦：退到它里面第一个能聚焦的控件。
      const focusable =
        element.matches('input, textarea, select, button, [tabindex]') === true
          ? element
          : element.querySelector<HTMLElement>('input, textarea, select, button, [tabindex]');
      element.scrollIntoView({ block: 'center' });
      focusable?.focus();
    }, EXPAND_SETTLE_MS);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="text-destructive">
            <TriangleAlertIcon />
            {t.editor.errorIndexCount(entries.length)}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <ItemGroup>
          {entries.map(([key, message]) => (
            <Item
              key={key}
              size="sm"
              className="w-full text-left"
              render={<button type="button" onClick={() => jump(key)} />}
            >
              <ItemContent>
                <ItemTitle>{ERROR_TARGETS[key].label}</ItemTitle>
                <ItemDescription>{stripLabel(message, ERROR_TARGETS[key].label)}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </PopoverContent>
    </Popover>
  );
};
