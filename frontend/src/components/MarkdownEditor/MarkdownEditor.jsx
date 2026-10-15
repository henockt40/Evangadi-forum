import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Bold, Code2, Heading1, Italic, Link2, List, ListOrdered, Quote } from 'lucide-react';
import styles from './MarkdownEditor.module.css';

const tools = [
  { id: 'bold', label: 'Bold', icon: Bold, prefix: '**', suffix: '**', placeholder: 'bold text' },
  { id: 'italic', label: 'Italic', icon: Italic, prefix: '*', suffix: '*', placeholder: 'italic text' },
  { id: 'heading', label: 'Heading 1', icon: Heading1, prefix: '# ', suffix: '', placeholder: 'heading', block: true },
  { id: 'bullet', label: 'Bulleted list', icon: List, prefix: '- ', suffix: '', placeholder: 'list item', block: true },
  { id: 'numbered', label: 'Numbered list', icon: ListOrdered, prefix: '1. ', suffix: '', placeholder: 'list item', block: true },
  { id: 'quote', label: 'Quote', icon: Quote, prefix: '> ', suffix: '', placeholder: 'quoted text', block: true },
  { id: 'inline-code', label: 'Inline code', icon: Code2, prefix: '`', suffix: '`', placeholder: 'code' },
  { id: 'code-block', label: 'Code block', icon: Code2, prefix: '```\n', suffix: '\n```', placeholder: 'your code here', block: true },
  { id: 'link', label: 'Link', icon: Link2, prefix: '[', suffix: '](https://)', placeholder: 'link text' },
];

export default function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 13,
  disabled = false,
  preview = true,
  className = '',
  ariaLabel = 'Markdown editor',
}) {
  const textareaRef = useRef(null);
  const [showPreview, setShowPreview] = useState(false);

  const apply = tool => {
    const textarea = textareaRef.current;
    if (!textarea || disabled || showPreview) return;

    let start = textarea.selectionStart;
    let end = textarea.selectionEnd;
    let selected = value.slice(start, end) || tool.placeholder;
    let prefix = tool.prefix;
    let suffix = tool.suffix;
    let lead = '';
    let replacement;

    if (tool.id === 'heading') {
      // Format the current line(s), including when only the cursor is positioned there.
      start = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', end);
      end = lineEnd === -1 ? value.length : lineEnd;
      selected = value.slice(start, end) || tool.placeholder;
      replacement = selected.split('\n').map(line => '# ' + line.replace(/^#{1,6}\s+/, '')).join('\n');
    } else {
      if (tool.id === 'bold' || tool.id === 'italic') {
        // Markdown emphasis does not work with spaces immediately inside its markers.
        const text = value.slice(start, end);
        if (text.trim()) {
          start += text.length - text.trimStart().length;
          end -= text.length - text.trimEnd().length;
          selected = value.slice(start, end);
        }
        // Clicking the same format again removes its markers.
        if (selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length > prefix.length + suffix.length) {
          selected = selected.slice(prefix.length, -suffix.length); prefix = ''; suffix = '';
        } else if (value.slice(Math.max(0, start - prefix.length), start) === prefix && value.slice(end, end + suffix.length) === suffix) {
          start -= prefix.length; end += suffix.length; prefix = ''; suffix = '';
        }
      }
      if (tool.block && start > 0 && value[start - 1] !== '\n') lead = '\n';
      replacement = `${lead}${prefix}${selected}${suffix}`;
    }
    const nextValue = `${value.slice(0, start)}${replacement}${value.slice(end)}`;

    onChange(nextValue);

    requestAnimationFrame(() => {
      textarea.focus();
      const cursorStart = start + lead.length + (tool.id === 'heading' ? 2 : prefix.length);
      const cursorEnd = Math.min(start + replacement.length, cursorStart + selected.length);
      textarea.setSelectionRange(cursorStart, cursorEnd);
    });
  };

  return (
    <div className={`${styles.editor} ${className}`}>
      <div className={styles.toolbar} role="toolbar" aria-label="Markdown formatting tools">
        <div className={styles.toolGroup}>
          {tools.map(tool => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.id}
                type="button"
                className={styles.toolButton}
                onMouseDown={event => event.preventDefault()}
                onClick={() => apply(tool)}
                disabled={disabled || showPreview}
                title={tool.label}
                aria-label={tool.label}
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>

        {preview && (
          <button
            type="button"
            className={`${styles.previewButton} ${showPreview ? styles.active : ''}`}
            onClick={() => setShowPreview(prev => !prev)}
            disabled={disabled}
          >
            {showPreview ? 'Edit' : 'Preview'}
          </button>
        )}
      </div>

      {showPreview ? (
        <div className={styles.preview} aria-label="Markdown preview">
          {value.trim() ? (
            <ReactMarkdown>{value}</ReactMarkdown>
          ) : (
            <p className={styles.emptyPreview}>Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          aria-label={ariaLabel}
          spellCheck="true"
        />
      )}

      <small className={styles.hint}>
        Markdown supported · Select text to format it. Use Preview to see the result.
      </small>
    </div>
  );
}
