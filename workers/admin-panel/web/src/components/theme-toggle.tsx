import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { t } from '@/lib/messages';

/**
 * 主题切换。深色是默认（index.html 的 html.dark），因为运维面板多在暗光下长时间
 * 使用；但白天工作的人应该能切走，所以三个选项都给。
 *
 * 官方的 ThemeProvider 还绑了 D 键，这里把它标出来 —— 一个没人知道的快捷键等于
 * 不存在。
 */
export const ThemeToggle = () => {
  const { theme, setTheme } = useTheme();
  const Icon = theme === 'dark' ? MoonIcon : theme === 'light' ? SunIcon : MonitorIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t.theme.label}>
            <Icon />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <SunIcon />
          {t.theme.light}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <MoonIcon />
          {t.theme.dark}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <MonitorIcon />
          {t.theme.system}
        </DropdownMenuItem>
        <div className="text-muted-foreground flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-xs">
          <Kbd>{t.theme.shortcutKey}</Kbd>
          <span>{t.theme.shortcutHint}</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
