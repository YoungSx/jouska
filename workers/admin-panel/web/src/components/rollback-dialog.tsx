import * as React from 'react';
import { HistoryIcon } from 'lucide-react';
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
import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, NetworkError, api, type RevisionEntry } from '@/lib/api';
import { t } from '@/lib/messages';
import { LIMITS, dangerReason, type FieldRisk } from '@/lib/types';

/**
 * 回滚弹窗 —— 与发布弹窗同一套闸门，因为回滚就是一次发布。
 *
 * 走两段式：第一段永远不带 confirm，服务端判出旧快照里有危险开关会回 409
 * confirmation_required，那时才展开清单并要求亲手勾一次。结构上不存在「忘了
 * 问」的路径，和发布弹窗是同一个理由。
 *
 * 与发布的区别只有一条：草稿会被重置成那一版。这永远写在弹窗里，因为它是
 * 回滚语义的一部分，不是危险开关的副作用。
 */

interface RollbackDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly source: RevisionEntry;
  /** 回滚成功后回调（带上新 revision）；关闭与刷新由调用方负责。 */
  readonly onRolledBack: (revision: number) => void;
}

/** 409 响应体里的 dangers 是未知形状（来自服务端）；轻量守卫，宁缺勿崩。 */
const asDangers = (raw: unknown): Record<string, readonly FieldRisk[]> => {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const dangers: Record<string, readonly FieldRisk[]> = {};
  for (const [routeId, risks] of Object.entries(raw)) {
    if (!Array.isArray(risks)) {
      continue;
    }
    const clean = risks.filter(
      (risk): risk is FieldRisk =>
        typeof risk === 'object' &&
        risk !== null &&
        typeof (risk as FieldRisk).path === 'string' &&
        typeof (risk as FieldRisk).reason === 'string',
    );
    if (clean.length > 0) {
      dangers[routeId] = clean;
    }
  }
  return dangers;
};

export const RollbackDialog = ({
  open,
  onOpenChange,
  source,
  onRolledBack,
}: RollbackDialogProps) => {
  const [note, setNote] = React.useState('');
  /** 确认段：只有服务端回过一次 confirmation_required 才会进入。 */
  const [confirming, setConfirming] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  const [bodyDangers, setBodyDangers] = React.useState<Record<string, readonly FieldRisk[]>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      return;
    }
    // 关闭即归位，和发布弹窗一个道理：下一轮回滚是新的决定。
    setNote('');
    setConfirming(false);
    setConfirmed(false);
    setBodyDangers({});
  }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      const { revision } = await api.rollback(
        source.revision,
        note.trim() || undefined,
        confirming && confirmed,
      );
      toast.success(t.history.rollback.ok(source.revision, revision));
      onRolledBack(revision);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'confirmation_required') {
        setConfirming(true);
        setBodyDangers(asDangers(error.body.dangers));
        setConfirmed(false);
        return;
      }
      if (error instanceof ApiError && error.code === 'already_live') {
        // 快照与线上内容一致，发布被拒——但服务端已把草稿重置为这一版，面板
        // 必须重新拉一遍草稿，否则操作者看到的还是被丢弃前的旧内容。没有新
        // revision，时间轴刷新只是空转，换来的草稿同步是必需的。
        toast.info(t.history.rollback.errors.already_live);
        onRolledBack(source.revision);
        return;
      }
      if (error instanceof NetworkError) {
        toast.error(t.common.networkError);
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        toast.error(t.common.sessionExpired);
        return;
      }
      if (error instanceof ApiError && error.code === 'forbidden') {
        toast.error(t.history.rollback.forbidden);
        return;
      }
      if (error instanceof ApiError) {
        const mapped = t.history.rollback.errors[error.code];
        // 已知错误码给下一步，未知码给原话 —— 不猜服务端没说过的事。
        toast.error(mapped ?? t.history.rollback.failed(error.code));
        return;
      }
      toast.error(t.history.rollback.failed(t.common.unknownError));
    } finally {
      setBusy(false);
    }
  };

  const dangerEntries = Object.entries(bodyDangers);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 回滚在途时不能关：关掉也不会取消请求，只会让人失去进度指示。
        if (busy && !next) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.history.rollback.title(source.revision)}</DialogTitle>
          <DialogDescription>{t.history.rollback.body}</DialogDescription>
        </DialogHeader>

        {/* 草稿重置是回滚的固有语义，无论有没有危险开关都要说。 */}
        <div className="danger-surface rounded-lg border p-3">
          <p className="text-destructive text-sm font-medium">{t.history.rollback.draftWarning}</p>
        </div>

        <Field>
          <FieldLabel htmlFor="rollback-note">{t.history.rollback.noteLabel}</FieldLabel>
          <Textarea
            id="rollback-note"
            value={note}
            placeholder={t.history.rollback.notePlaceholder}
            maxLength={LIMITS.noteLength}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldDescription>{t.publish.noteHint(LIMITS.noteLength)}</FieldDescription>
        </Field>

        {dangerEntries.length > 0 && (
          // 与发布弹窗的危险区块同一底色：两处说的是同一件事。
          <div className="danger-surface flex flex-col gap-2 rounded-lg border p-3">
            <p className="text-destructive text-sm font-medium">{t.history.rollback.dangerLead}</p>
            <ul className="flex flex-col gap-1.5">
              {dangerEntries.flatMap(([routeId, risks]) =>
                risks.map((risk) => (
                  <li key={`${routeId}.${risk.path}`} className="flex flex-col gap-0.5">
                    <code className="font-mono text-xs">
                      {routeId}.{risk.path}
                    </code>
                    <span className="text-muted-foreground text-xs">{dangerReason(risk)}</span>
                  </li>
                )),
              )}
            </ul>
          </div>
        )}

        {confirming && (
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked)}
              disabled={busy}
            />
            <span className="text-muted-foreground">{t.history.rollback.confirmSwitches}</span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t.history.rollback.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || (confirming && !confirmed)}>
            {busy ? <Spinner /> : <HistoryIcon />}
            {busy ? t.publishBar.publishing : t.history.rollback.confirmAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
