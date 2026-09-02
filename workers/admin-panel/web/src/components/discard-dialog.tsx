import * as React from 'react';
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, NetworkError, api } from '@/lib/api';
import { t } from '@/lib/messages';

/**
 * 舍弃草稿弹窗 —— 发布的草稿侧镜像，不是一次发布。
 *
 * 服务端不写 KV、不产生 revision、不过发布闸（没有危险开关门），所以这里
 * 没有 confirm 两段式，弹一次框把语义说清就走。快照刻意不做 schema 门：
 * 草稿编译不过（blocked）恰恰是最需要这条路的时候，逃生舱不能自己上锁。
 */
interface DiscardDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 正在服务的 revision，快照的来源；弹窗文案要说清恢复到哪一版。 */
  readonly liveRevision: number;
  /** 舍弃成功后回调；关闭与刷新由调用方负责。 */
  readonly onDiscarded: () => void;
}

export const DiscardDialog = ({
  open,
  onOpenChange,
  liveRevision,
  onDiscarded,
}: DiscardDialogProps) => {
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    // 舍弃是服务端写操作；关窗不撤销请求，在途时锁住按钮即可。
    setBusy(false);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      const { sourceRevision } = await api.discardDraft();
      toast.success(t.discard.ok(sourceRevision > 0 ? sourceRevision : liveRevision));
      onDiscarded();
    } catch (error) {
      if (error instanceof NetworkError) {
        toast.error(t.common.networkError);
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        toast.error(t.common.sessionExpired);
        return;
      }
      if (error instanceof ApiError && error.code === 'forbidden') {
        toast.error(t.discard.forbidden);
        return;
      }
      if (error instanceof ApiError) {
        const mapped = t.discard.errors[error.code];
        // 已知错误码给下一步，未知码给原话 —— 不猜服务端没说过的事。
        toast.error(mapped ?? t.discard.failed(error.code));
        return;
      }
      toast.error(t.discard.failed(t.common.unknownError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 舍弃在途时不能关：关掉也不会取消请求，只会让人失去进度指示。
        if (busy && !next) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.discard.title}</DialogTitle>
          <DialogDescription>{t.discard.body(liveRevision)}</DialogDescription>
        </DialogHeader>

        {/* park 语义是舍弃的一部分，写出来比让人猜强：新建的路由不会没。 */}
        <p className="text-muted-foreground rounded-lg border p-3 text-sm">{t.discard.parkNote}</p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t.discard.cancel}
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner /> : <Trash2Icon />}
            {busy ? t.discard.confirming : t.discard.confirmAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
