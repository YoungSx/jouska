/**
 * "Advanced" — timing, rewriting, upstream headers, plus whatever the form does
 * not model yet.
 *
 * Three accordion cards for people whose defaults already work, and one block at
 * the end for keys the form cannot render: those stay in the draft untouched and
 * still get their danger notes, because the form not knowing a field does not make
 * the field harmless.
 */
import { Accordion, AccordionContent, AccordionItem } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/messages';
import { BODY_REWRITE_BOOLEAN_DEFAULTS, BOOLEAN_DEFAULTS, NUMERIC_BOUNDS } from '@/lib/types';
import {
  advancedItemSet,
  BODY_REWRITE_BOOLEAN_FIELDS,
  BODY_REWRITE_BOOLEAN_KEYS,
  BOOLEAN_FIELDS,
  BOOLEAN_KEYS,
  NUMERIC_FIELDS,
  NUMERIC_KEYS,
  TIMING_PRESET_BUTTONS,
} from './constants';
import { HeadersEditor, ReplaceEditor } from './editors';
import { dangerousSubPaths } from './errors';
import { ListProperty, NumberProperty, SwitchProperty, TextProperty } from './fields';
import { DangerNote, hasText, Hint, previewValue, RewriteNote, SectionCardTrigger } from './parts';
import type { RouteDraft } from './use-route-draft';

export const SectionAdvanced = ({ draft }: { readonly draft: RouteDraft }) => {
  const {
    definition,
    shownErrors,
    advancedOpen,
    setAdvancedOpen,
    setTopLevel,
    setTopLevelFields,
    setSectionOn,
    setSectionOff,
    setSectionKey,
    setBoolean,
    boolValue,
    setBodyRewriteBoolean,
    bodyRewriteBoolValue,
    flashedKeys,
    flashFields,
    reservedHeaders,
    unknownKeys,
  } = draft;
  return (
    <>
      {/* 「高级」三卡：默认值已经够用的人永远不需要展开这里。 */}
      <div className="flex flex-col gap-2">
        <FieldLegend>{t.fields.sections.advanced}</FieldLegend>
        <FieldDescription>
          <Hint text={t.fields.sections.advancedHint} />
        </FieldDescription>
      </div>
      <Accordion value={advancedOpen} onValueChange={setAdvancedOpen}>
        <AccordionItem value="timing">
          <SectionCardTrigger
            label={t.fields.sections.timing}
            set={advancedItemSet(definition, 'timing')}
            needsFix={NUMERIC_KEYS.some((key) => shownErrors[key] !== undefined)}
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              {/* 预设行：一次性模板。点按只填该预设覆盖的框，之后它们就是
                      普通数字，随便改 —— 配置里永远没有「指向预设」的引用。
                      闪烁只标记刚写过的框，不抢焦点：焦点属于用户。 */}
              <div className="flex flex-wrap items-start gap-2">
                {TIMING_PRESET_BUTTONS.map((preset) => (
                  <Button
                    key={preset.name}
                    type="button"
                    variant="outline"
                    size="sm"
                    title={preset.description}
                    onClick={() => {
                      const values: Record<string, unknown> = preset.values;
                      setTopLevelFields(
                        Object.fromEntries(preset.keys.map((key) => [key, values[key]])),
                      );
                      flashFields(preset.keys);
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title={t.fields.sections.presetClearDesc}
                  onClick={() => {
                    setTopLevelFields(
                      Object.fromEntries(NUMERIC_KEYS.map((key) => [key, undefined])),
                    );
                    flashFields([...NUMERIC_KEYS]);
                  }}
                >
                  {t.fields.sections.presetClear}
                </Button>
              </div>
              <FieldDescription>
                <Hint text={t.fields.sections.presetHint} />
              </FieldDescription>

              {NUMERIC_KEYS.map((key) => (
                <NumberProperty
                  key={key}
                  id={`route-editor-${key}`}
                  label={NUMERIC_FIELDS[key].label}
                  unit={NUMERIC_FIELDS[key].unit}
                  hint={t.fields[key].help}
                  value={definition[key] === undefined ? '' : String(definition[key])}
                  min={NUMERIC_BOUNDS[key].min}
                  max={NUMERIC_BOUNDS[key].max}
                  error={shownErrors[key]}
                  flashed={flashedKeys.includes(key)}
                  onChange={(raw) => {
                    // 数字直接存，越界与非整数交给校验就地说清；空串 = 未设置。
                    const next = raw === '' ? undefined : Number(raw);
                    setTopLevel(key, next !== undefined && Number.isNaN(next) ? undefined : next);
                  }}
                />
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="rewrite">
          <SectionCardTrigger
            label={t.fields.sections.rewrite}
            set={advancedItemSet(definition, 'rewrite')}
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <FieldDescription>
                <Hint text={t.fields.sections.rewriteHint} />
              </FieldDescription>

              {/* stripPrefix 已随 path 搬去「去哪里」：它只改转发路径，不属于改写。 */}
              {BOOLEAN_KEYS.filter((key) => key !== 'stripPrefix').map((key) => (
                <SwitchProperty
                  key={key}
                  id={BOOLEAN_FIELDS[key].id}
                  label={BOOLEAN_FIELDS[key].label}
                  hint={BOOLEAN_FIELDS[key].help}
                  defaultNote={t.common.defaultValue(String(BOOLEAN_DEFAULTS[key]))}
                  checked={boolValue(key)}
                  onCheckedChange={(checked) => setBoolean(key, checked)}
                />
              ))}

              <Field orientation="horizontal">
                <Switch
                  id="route-editor-body-rewrite"
                  checked={definition.bodyRewrite !== undefined}
                  onCheckedChange={(checked) =>
                    checked ? setSectionOn('bodyRewrite') : setSectionOff('bodyRewrite')
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="route-editor-body-rewrite">
                    {t.fields.bodyRewrite.label}
                  </FieldLabel>
                  <FieldDescription>
                    <Hint text={t.fields.bodyRewrite.help} />
                  </FieldDescription>
                </FieldContent>
              </Field>

              {definition.bodyRewrite !== undefined && (
                <>
                  <RewriteNote />
                  {BODY_REWRITE_BOOLEAN_KEYS.map((key) => (
                    <SwitchProperty
                      key={key}
                      id={BODY_REWRITE_BOOLEAN_FIELDS[key].id}
                      label={BODY_REWRITE_BOOLEAN_FIELDS[key].label}
                      hint={BODY_REWRITE_BOOLEAN_FIELDS[key].help}
                      defaultNote={t.common.defaultValue(
                        String(BODY_REWRITE_BOOLEAN_DEFAULTS[key]),
                      )}
                      checked={bodyRewriteBoolValue(key)}
                      onCheckedChange={(checked) => setBodyRewriteBoolean(key, checked)}
                    />
                  ))}
                  <ListProperty
                    id="route-editor-body-rewrite-content-types"
                    label={t.fields.bodyRewrite.contentTypes}
                    hint={t.fields.bodyRewrite.contentTypesHelp}
                    value={definition.bodyRewrite.contentTypes}
                    onChange={(value) => setSectionKey('bodyRewrite', 'contentTypes', value)}
                  />
                  {(definition.bodyRewrite.contentTypes?.length ?? 0) > 0 && (
                    <DangerNote path="bodyRewrite.contentTypes" />
                  )}
                  <Field>
                    <FieldLabel>{t.fields.bodyRewrite.replace}</FieldLabel>
                    <FieldDescription>
                      <Hint text={t.fields.bodyRewrite.replaceHelp} />
                    </FieldDescription>
                    <ReplaceEditor
                      value={definition.bodyRewrite.replace}
                      onChange={(value) => setSectionKey('bodyRewrite', 'replace', value)}
                    />
                  </Field>
                  <TextProperty
                    id="route-editor-body-rewrite-fallback-charset"
                    label={t.fields.bodyRewrite.fallbackCharset}
                    hint={t.fields.bodyRewrite.fallbackCharsetHelp}
                    mono
                    value={definition.bodyRewrite.fallbackCharset ?? ''}
                    onChange={(value) =>
                      setSectionKey(
                        'bodyRewrite',
                        'fallbackCharset',
                        value === '' ? undefined : value,
                      )
                    }
                  />
                  {hasText(definition.bodyRewrite.fallbackCharset) && (
                    <DangerNote path="bodyRewrite.fallbackCharset" />
                  )}
                </>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="headers">
          <SectionCardTrigger
            label={t.fields.sections.headers}
            set={advancedItemSet(definition, 'headers')}
            needsFix={reservedHeaders.length > 0}
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <FieldDescription>
                <Hint text={t.fields.sections.headersHint} />
              </FieldDescription>

              <Field>
                <FieldLabel>{t.fields.upstreamHeaders.label}</FieldLabel>
                <FieldDescription>
                  <Hint text={t.fields.upstreamHeaders.help} />
                </FieldDescription>
                <HeadersEditor
                  value={definition.upstreamHeaders}
                  onChange={(value) => setTopLevel('upstreamHeaders', value)}
                />
                {reservedHeaders.length > 0 && (
                  <FieldError>
                    {t.fields.upstreamHeaders.reserved(reservedHeaders.join(', '))}
                  </FieldError>
                )}
              </Field>
              {Object.keys(definition.upstreamHeaders ?? {}).length > 0 && (
                <DangerNote path="upstreamHeaders" />
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {unknownKeys.length > 0 && (
        <div className="bg-muted/40 rounded-lg border p-3">
          <div className="text-sm font-medium">{t.fields.unknownFields.label}</div>
          <p className="text-muted-foreground mt-1 text-xs">
            <Hint text={t.fields.unknownFields.help} />
          </p>
          <dl className="mt-2 flex flex-col gap-2">
            {unknownKeys.map((key) => (
              <div key={key} className="flex flex-col gap-0.5">
                <dt className="font-mono text-xs">{key}</dt>
                <dd className="text-muted-foreground font-mono text-xs break-all">
                  {previewValue(definition[key])}
                </dd>
                {t.fields.unknownFields.keyHelp[key] !== undefined && (
                  <dd className="text-muted-foreground text-xs">
                    {t.fields.unknownFields.keyHelp[key]}
                  </dd>
                )}
                {dangerousSubPaths(key, definition[key]).map((path) => (
                  <dd key={path}>
                    <DangerNote path={path} />
                  </dd>
                ))}
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
};
