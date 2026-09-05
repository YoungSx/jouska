/**
 * The one-shot API key generator for `access.keys`.
 *
 * The field stores SHA-256 digests, never the key. Until now the panel explained
 * how to produce that pair with a shell pipeline in a hint — correct, and a wall:
 * it asked an operator who came here to avoid the terminal to go open one, and it
 * left them holding two hex-looking strings with no way to tell which was which.
 *
 * Now the browser does it. The plaintext is shown exactly once, in a field you can
 * copy from, and only the digest is written into the draft. Nothing else ever holds
 * the plaintext: it lives in this component's state and dies when the card closes.
 */
import * as React from 'react';
import { CheckIcon, CopyIcon, KeyRoundIcon } from 'lucide-react';
import { sha256Hex } from '@jouska/digest';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { t } from '@/lib/messages';

/**
 * 32 字节随机，base64url 编码。
 *
 * base64url 而不是 hex：同样的熵短一半，而且不用转义就能塞进请求头或 URL —— 这把
 * key 的下一站正是某个客户端的 header。
 */
const generateKey = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

export const AccessKeyGenerator = ({
  onDigest,
}: {
  /** 生成成功后把摘要交给调用方追加进 access.keys。 */
  readonly onDigest: (digest: string) => void;
}) => {
  const [plaintext, setPlaintext] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const generate = async () => {
    setBusy(true);
    const key = generateKey();
    try {
      const digest = await sha256Hex(key);
      onDigest(digest);
      setPlaintext(key);
      setCopied(false);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (plaintext === null) {
      return;
    }
    await navigator.clipboard.writeText(plaintext);
    setCopied(true);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={busy}
        onClick={() => void generate()}
      >
        <KeyRoundIcon />
        {t.fields.access.keyGenerate}
      </Button>

      {plaintext !== null && (
        /*
          明文用 danger-surface 标出来：它是这一屏里唯一一件「关掉就再也拿不回来」
          的东西，而 DESIGN.md 把这块底色定义为「需要亲手确认的区域」。
        */
        <Field className="danger-surface">
          <FieldLabel htmlFor="route-editor-access-key-plaintext">
            {t.fields.access.keyPlaintext}
          </FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="route-editor-access-key-plaintext"
              readOnly
              className="font-mono"
              value={plaintext}
              onFocus={(event) => event.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="button"
                aria-label={t.fields.access.keyCopy}
                onClick={() => void copy()}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>{t.fields.access.keyPlaintextHint}</FieldDescription>
        </Field>
      )}
    </>
  );
};
