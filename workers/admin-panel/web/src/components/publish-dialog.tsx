import * as React from 'react';
import { UploadIcon } from 'lucide-react';
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, NetworkError, api, type PreviewResult } from '@/lib/api';
import { t } from '@/lib/messages';
import { DANGER_REASONS, LIMITS, type FieldRisk } from '@/lib/types';

/**
 * 发布弹窗 —— 整个面板里唯一一处真正改变线上流量的按钮。
 *
 * 走两段式：第一段永远不带 confirm，服务端若判出危险开关会回 409
 * confirmation_required，那时才在弹窗里就地展开清单并要求亲手勾一次。第一段
 * 就带 confirm=true 等于替服务端的二次确认放行，所以这里把「是否处于确认段」
 * 和「是否已勾选」做成两个独立的 state，confirm 参数是它们的合取 —— 两个都
 * 为真才可能发出 true，结构上就不存在「忘了问」的路径。
 */

interface PublishDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 打开弹窗那一刻的预览；它的 dangers 只是预告，最终以服务端 409 里的为准。 */
  readonly preview: PreviewResult | null;
  /** 发布成功后回调（带上新 revision）；关闭弹窗与刷新由调用方负责。 */
  readonly onPublished: (revision: number) => void;
}

/** 服务端的 reason 是英文；DANGER_REASONS 是面板自己的说法，优先用它。 */
const reasonOf = (risk: FieldRisk): string => DANGER_REASONS[risk.path] ?? risk.reason;

/**
 * 409 响应体里的 dangers 是未知形状（来自服务端，且版本可能不同）。这里只做
 * 轻量守卫，不合格的条目丢掉 —— 宁可少列一行也不把 undefined 渲染出来。
 */
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

export const PublishDialog = ({ open, onOpenChange, preview, onPublished }: PublishDialogProps) => {
  const [note, setNote] = React.useState('');
  /** 确认段：只有服务端回过一次 confirmation_required 才会进入。 */
  const [confirming, setConfirming] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  /** 服务端 409 里给的最终危险清单；比 preview.dangers 权威。 */
  const [bodyDangers, setBodyDangers] = React.useState<Record<string, readonly FieldRisk[]>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      return;
    }
    // 关闭即归位：下一轮发布是一次新的决定，勾过的确认不作数，服务端会重判。
    // note 也清空 —— 发布成功后备注已经进了审计日志，留着会让人以为还没发布。
    setNote('');
    setConfirming(false);
    setConfirmed(false);
  }, [open]);

  const submit = async () => {
    setBusy(true);
    try {
      const { revision } = await api.publish(note.trim() || undefined, confirming && confirmed);
      toast.success(t.publish.ok(revision));
      onPublished(revision);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'confirmation_required') {
        // 服务端要一次亲手确认：进入确认段、换上它给的权威清单、勾选从零开始。
        setConfirming(true);
        setBodyDangers(asDangers(error.body.dangers));
        setConfirmed(false);
        return;
      }
      if (error instanceof ApiError && error.code === 'already_live') {
        // 线上已是这版内容——多半是另一标签页抢先发布过，本 tab 的 gate 陈旧。
        // 没有可确认、可重试的事，关掉弹窗比留一个注定 409 的按钮更诚实。
        toast.info(t.preview.alreadyLive);
        onOpenChange(false);
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
        toast.error(t.publish.forbidden);
        return;
      }
      const detail =
        error instanceof ApiError
          ? error.code
          : error instanceof Error
            ? error.message
            : t.common.unknownError;
      toast.error(t.publish.failed(detail));
    } finally {
      setBusy(false);
    }
  };

  const previewDangers = preview?.dangers ?? {};
  // 未进入确认段时展示预览里的预告；确认段里以服务端 409 的清单为准。
  const dangers = confirming && Object.keys(bodyDangers).length > 0 ? bodyDangers : previewDangers;
  const dangerEntries = Object.entries(dangers);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 发布在途时不能关：关掉也不会取消请求，只会让人失去进度指示。
        if (busy && !next) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.publish.confirmTitle}</DialogTitle>
          <DialogDescription>{t.publish.confirmBody}</DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="publish-note">{t.publish.noteLabel}</FieldLabel>
          <Textarea
            id="publish-note"
            value={note}
            placeholder={t.publish.notePlaceholder}
            maxLength={LIMITS.noteLength}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <FieldDescription>{t.publish.noteHint(LIMITS.noteLength)}</FieldDescription>
        </Field>

        {dangerEntries.length > 0 && (
          // 与预览页的危险区块同一底色：两处说的是同一件事。
          <div className="danger-surface flex flex-col gap-2 rounded-lg border p-3">
            <p className="text-destructive text-sm font-medium">{t.publish.confirmDangerLead}</p>
            <ul className="flex flex-col gap-1.5">
              {dangerEntries.flatMap(([routeId, risks]) =>
                risks.map((risk) => (
                  // path 是路由内的相对路径，不带路由 ID 就对不上号。
                  <li key={`${routeId}.${risk.path}`} className="flex flex-col gap-0.5">
                    <code className="font-mono text-xs">
                      {routeId}.{risk.path}
                    </code>
                    <span className="text-muted-foreground text-xs">{reasonOf(risk)}</span>
                  </li>
                )),
              )}
            </ul>
          </div>
        )}

        {confirming && (
          // 只有这一段勾选才算数；勾与不勾直接决定下一次请求带不带 confirm。
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={confirmed}
              onCheckedChange={(checked) => setConfirmed(checked)}
              disabled={busy}
            />
            <span className="text-muted-foreground">{t.publish.confirmSwitches}</span>
          </label>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t.publish.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || (confirming && !confirmed)}>
            {busy ? <Spinner /> : <UploadIcon />}
            {busy ? t.publishBar.publishing : t.publish.confirmAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
