import { Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { type UserEntry } from '@/lib/api';
import { t } from '@/lib/messages';

/**
 * 删除用户的确认弹窗。与 DeleteRouteDialog 同一形态：删除是写操作，必须问过
 * 一次；理由写在正文里而不是标题上。self 的那一行按钮已禁用，这里再挂一道
 * 说明是给「确认框开着时列表刷新、target 换了人」的边缘兜底。
 */
const UserDeleteDialog = ({
  target,
  selfSubject,
  onDismiss,
  onConfirm,
}: {
  target: UserEntry | null;
  selfSubject: string;
  onDismiss: () => void;
  onConfirm: (target: UserEntry) => void;
}) => (
  <Dialog open={target !== null} onOpenChange={(open: boolean) => open || onDismiss()}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{target === null ? '' : t.users.deleteTitle(target.subject)}</DialogTitle>
        <DialogDescription>{t.users.deleteBody}</DialogDescription>
      </DialogHeader>
      {target !== null && target.subject === selfSubject && (
        <p className="text-muted-foreground text-sm">{t.users.deleteSelfNote}</p>
      )}
      {target !== null && target.tokenCount > 0 && (
        <p className="text-sm">{t.users.deleteTokenWarning(target.tokenCount)}</p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onDismiss}>
          {t.common.cancel}
        </Button>
        <Button
          variant="destructive"
          disabled={target === null}
          onClick={() => target !== null && onConfirm(target)}
        >
          <Trash2Icon />
          {t.users.confirm}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export { UserDeleteDialog };
