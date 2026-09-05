/**
 * The raw JSON view of the definition.
 *
 * Two things the form cannot offer live here: fields the form does not model, and
 * the ability to read the whole route at once. The escape hatch matters as much as
 * the editor — a broken document must never be a locked door, so "drop the JSON
 * edits" restores the last definition the form still holds.
 */
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/messages';
import { Hint } from './parts';
import type { RouteDraft } from './use-route-draft';

export const SectionJson = ({ draft }: { readonly draft: RouteDraft }) => {
  const { jsonText, jsonError, handleJsonChange, escapeJson, formatJson } = draft;
  return (
    <Field data-invalid={jsonError !== null ? true : undefined}>
      {/* 标签与格式化并排：格式化作用于下面这一个框，放在框的正上方才对得上。 */}
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor="route-editor-json">{t.editor.jsonLabel}</FieldLabel>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={jsonError !== null || jsonText.trim() === ''}
          title={jsonError !== null ? t.editor.jsonFormatBlocked : undefined}
          onClick={formatJson}
        >
          {t.editor.jsonFormat}
        </Button>
      </div>
      {/*
        整页之后这个框终于能长高：从前 288px 是被居中弹窗的 85dvh 逼出来的上限。
        窄屏仍收一档 —— 手机上把 JSON 之外的东西全顶出可视区不是「更大的编辑器」。
      */}
      <Textarea
        id="route-editor-json"
        className="min-h-64 font-mono text-xs sm:min-h-96"
        spellCheck={false}
        value={jsonText}
        aria-invalid={jsonError !== null}
        onChange={(event) => handleJsonChange(event.target.value)}
      />
      {jsonError !== null ? (
        <>
          <FieldError>{jsonError}</FieldError>
          {/* 逃生门：JSON 改坏了不必手工逐字修——丢掉 JSON 里的改动，回表单继续。 */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={escapeJson}
          >
            {t.editor.jsonEscape}
          </Button>
        </>
      ) : (
        <FieldDescription>
          <Hint text={t.editor.jsonHint} />
        </FieldDescription>
      )}
    </Field>
  );
};
