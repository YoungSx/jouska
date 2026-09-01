import * as React from 'react';
import { SaveIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { jsonByteLength } from '@/lib/format';
import { t } from '@/lib/messages';
import { LIMITS } from '@/lib/types';

/**
 * 表级 defaults。
 *
 * 保持 JSON 文本域而不是做成表单：defaults 的字段集合与路由完全相同，把同一套
 * 二十多个控件再画一遍，操作者要在两个几乎一样的表单之间分辨自己在改哪个。这里
 * 的内容通常只有两三个字段（timeoutMs、retries），JSON 反而更快也更不容易看错。
 */

interface DefaultsCardProps {
  readonly defaults: Record<string, unknown> | null;
  readonly isAdmin: boolean;
  readonly onSave: (defaults: Record<string, unknown>) => Promise<void>;
}

export const DefaultsCard = ({ defaults, isAdmin, onSave }: DefaultsCardProps) => {
  const serialized = React.useMemo(
    () => (defaults === null ? '' : JSON.stringify(defaults, null, 2)),
    [defaults],
  );
  // 外层用 key={serialized} 重挂本组件，所以这里的初始值总是最新的服务端值，
  // 不需要在渲染期同步 state。
  const [text, setText] = React.useState(serialized);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const dirty = text !== serialized;

  const save = async () => {
    // 空文本等于「没有 defaults」，写成 {} 而不是报错 —— 清空是一个合理意图。
    let parsed: unknown;
    if (text.trim() === '') {
      parsed = {};
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        setError(t.defaults.invalidJson);
        return;
      }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError(t.defaults.invalidJson);
      return;
    }
    if (jsonByteLength(parsed) > LIMITS.defaultsBytes) {
      setError(t.defaults.tooBig(LIMITS.defaultsBytes / 1024));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(parsed as Record<string, unknown>);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.defaults.title}</CardTitle>
        <CardDescription>{t.defaults.description}</CardDescription>
        {isAdmin && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={save} disabled={!dirty || saving}>
              {saving ? <Spinner /> : <SaveIcon />}
              {saving ? t.defaults.saving : t.defaults.save}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <Field data-invalid={error !== null ? true : undefined}>
          <FieldLabel htmlFor="defaults-json">{t.defaults.label}</FieldLabel>
          <Textarea
            id="defaults-json"
            className="min-h-32 font-mono text-xs"
            spellCheck={false}
            value={text}
            placeholder={t.defaults.emptyPlaceholder}
            disabled={!isAdmin}
            aria-invalid={error !== null}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
          {error !== null ? (
            <FieldError>{error}</FieldError>
          ) : (
            !isAdmin && <FieldDescription>{t.account.viewerReadonly}</FieldDescription>
          )}
        </Field>
      </CardContent>
    </Card>
  );
};
