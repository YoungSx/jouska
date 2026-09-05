/**
 * "Where does it go" — the request matcher and the upstream, in one section.
 *
 * Match and upstream used to be two sections. They were merged because in the
 * operator's head "which requests" and "where do they go" is a single question;
 * two headings only made them page back and forth to line the two halves up.
 *
 * On a wide screen this is the whole left column: everything here is required
 * before the route can go live.
 */
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { t } from '@/lib/messages';
import { BOOLEAN_DEFAULTS, HTTP_METHODS, SCHEME_DEFAULT } from '@/lib/types';
import { BOOLEAN_FIELDS, SCHEME_UNSET } from './constants';
import { ConditionsEditor } from './editors';
import { HostProperty, SwitchProperty, TextProperty } from './fields';
import { DangerNote, Hint } from './parts';
import type { RouteDraft } from './use-route-draft';

export const SectionDestination = ({ draft }: { readonly draft: RouteDraft }) => {
  const {
    definition,
    shownErrors,
    setTopLevel,
    setMatchKey,
    setMethods,
    setConditionRows,
    boolValue,
    setBoolean,
    hostOptions,
    hostBindings,
  } = draft;
  return (
    <FieldSet>
      <FieldLegend>{t.fields.sections.destination}</FieldLegend>
      <FieldDescription>
        <Hint text={t.fields.sections.destinationHint} />
      </FieldDescription>

      <HostProperty
        id="route-editor-match-host"
        label={t.fields.matchHost.label}
        hint={t.fields.matchHost.help}
        placeholder={t.fields.matchHost.placeholder}
        value={definition.match?.host ?? ''}
        options={hostOptions}
        fallbackNote={
          hostBindings !== null && hostOptions.length === 0 ? t.editor.hostFallbackNote : undefined
        }
        onChange={(value) => setMatchKey('host', value === '' ? undefined : value)}
      />
      <TextProperty
        id="route-editor-match-path"
        label={t.fields.matchPath.label}
        hint={t.fields.matchPath.help}
        placeholder={t.fields.matchPath.placeholder}
        mono
        value={definition.match?.path ?? ''}
        onChange={(value) => setMatchKey('path', value === '' ? undefined : value)}
      />

      <Field>
        <FieldLabel>{t.fields.matchMethods.label}</FieldLabel>
        <FieldDescription>
          <Hint text={t.fields.matchMethods.help} />
        </FieldDescription>
        {/*
          官方 ToggleGroup（multiple）取代从前七个手写 label 包 Checkbox：一组互不
          排斥的开关本来就是它的语义，键盘方向键与 aria 也由它给。

          触摸下每个 item 自己长到 44px —— 这比从前那条实测决策更实在：伪元素铺出
          来的命中面在换行时会上下互吞（点第二行命中第一行），而按钮真的变高不会，
          它把相邻的行推开了。
        */}
        <ToggleGroup
          multiple
          variant="outline"
          className="flex-wrap"
          aria-label={t.fields.matchMethods.label}
          value={[...(definition.match?.methods ?? [])]}
          onValueChange={(methods: string[]) => setMethods(methods)}
        >
          {HTTP_METHODS.map((method) => (
            <ToggleGroupItem key={method} value={method} className="font-mono text-xs touch:h-11">
              {method}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>

      <Field
        id="route-editor-conditions"
        data-invalid={shownErrors.matchConditions !== undefined ? true : undefined}
      >
        <FieldLabel>{t.fields.matchConditions.label}</FieldLabel>
        <FieldDescription>
          <Hint text={t.fields.matchConditions.help} />
        </FieldDescription>
        <ConditionsEditor match={definition.match} onChange={setConditionRows} />
        {shownErrors.matchConditions !== undefined && (
          <FieldError>{shownErrors.matchConditions}</FieldError>
        )}
      </Field>
      <TextProperty
        id="route-editor-upstream"
        label={t.fields.upstream.label}
        hint={t.fields.upstream.help}
        placeholder={t.fields.upstream.placeholder}
        mono
        error={shownErrors.upstream}
        value={typeof definition.upstream === 'string' ? definition.upstream : ''}
        onChange={(value) => {
          // upstream 里空格永远是错字，输入时就去掉；协议头交给校验拦。
          const next = value.trim();
          setTopLevel('upstream', next === '' ? undefined : next);
        }}
      />

      <Field data-invalid={shownErrors.scheme !== undefined ? true : undefined}>
        <FieldLabel htmlFor="route-editor-scheme">{t.fields.scheme.label}</FieldLabel>
        <Select
          value={definition.scheme ?? SCHEME_UNSET}
          onValueChange={(value) =>
            setTopLevel('scheme', value === 'http' || value === 'https' ? value : undefined)
          }
        >
          {/*
                      Field vertical 的 `*:w-full` 与 w-44 同特异性且排在后面，普通
                      w-44 是死代码（实测桌面下这个下拉是 640px 宽，不是 176px），所
                      以要 important。窄屏留全宽：触摸目标越宽越好按。
                    */}
          <SelectTrigger
            id="route-editor-scheme"
            className="sm:w-44!"
            aria-label={t.fields.scheme.label}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SCHEME_UNSET}>{t.common.unset}</SelectItem>
            <SelectItem value="https">https</SelectItem>
            <SelectItem value="http">http</SelectItem>
          </SelectContent>
        </Select>
        <FieldDescription>
          <Hint text={t.fields.scheme.help} /> {t.common.defaultValue(SCHEME_DEFAULT)}
        </FieldDescription>
        {shownErrors.scheme !== undefined && <FieldError>{shownErrors.scheme}</FieldError>}
      </Field>
      {definition.scheme === 'http' && <DangerNote path="scheme" />}

      {/* stripPrefix 跟着 path 走：它决定转发时保不保留匹配前缀，是「去哪里」
                      这条链路的最后一站。放在改写区会让人在错误的层找它。 */}
      <SwitchProperty
        id={BOOLEAN_FIELDS.stripPrefix.id}
        label={BOOLEAN_FIELDS.stripPrefix.label}
        hint={BOOLEAN_FIELDS.stripPrefix.help}
        defaultNote={t.common.defaultValue(String(BOOLEAN_DEFAULTS.stripPrefix))}
        checked={boolValue('stripPrefix')}
        onCheckedChange={(checked) => setBoolean('stripPrefix', checked)}
      />

      <SwitchProperty
        id="route-editor-allow-private"
        label={t.fields.allowPrivateUpstream.label}
        hint={t.fields.allowPrivateUpstream.help}
        checked={definition.allowPrivateUpstream === true}
        onCheckedChange={(checked) =>
          setTopLevel('allowPrivateUpstream', checked ? true : undefined)
        }
      />
      {definition.allowPrivateUpstream === true && <DangerNote path="allowPrivateUpstream" />}
    </FieldSet>
  );
};
