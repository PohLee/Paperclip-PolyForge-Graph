import React from 'react';
import { useHostNavigation } from '@paperclipai/plugin-sdk/ui';

const styles = `
.pfg-destinations {display:flex;align-items:center;flex-wrap:wrap;gap:4px 18px;margin:0 0 22px;padding:0 0 2px;border-bottom:1px solid var(--border)}
.pfg-destinations a {display:inline-flex;align-items:center;min-height:38px;padding:5px 1px;color:var(--muted-foreground);font:inherit;font-size:13px;font-weight:550;text-decoration:none;border-bottom:2px solid transparent}
.pfg-destinations a[aria-current=page] {color:var(--foreground);border-color:currentColor}
.pfg-destinations a:hover {color:var(--foreground);text-decoration:underline;text-underline-offset:4px}
.pfg-destinations a:focus-visible {outline:2px solid var(--ring);outline-offset:2px}
.pfg-destinations .pfg-short-label {display:none}
@container (max-width:440px) {
  .pfg-destinations {gap:4px 16px;margin-bottom:16px}
  .pfg-destinations a {min-height:44px}
  .pfg-destinations .pfg-full-label {display:none}
  .pfg-destinations .pfg-short-label {display:inline}
}
`;

export function WorkspaceNav({ active, dirty }) {
  const navigation = useHostNavigation();
  const links = [
    ['operations', 'Company operations', 'Operations', '/company-operations'],
    ['runs', 'Graph runs', 'Runs', '/graph-runs'],
    ['settings', 'Graph settings', 'Settings', '/graph-settings'],
  ];
  return <nav aria-label="PolyForge workspace" className="pfg-destinations"><style>{styles}</style>
    {links.map(([id, label, shortLabel, path]) => {
      const link = navigation.linkProps(path);
      return <a {...link} key={id} aria-label={label} aria-current={active === id ? 'page' : undefined} onClick={event => {
        if (dirty && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey &&
            !window.confirm('Discard unsaved changes and leave this page?')) {
          event.preventDefault();
          return;
        }
        link.onClick(event);
      }}><span className="pfg-full-label">{label}</span><span className="pfg-short-label">{shortLabel}</span></a>;
    })}
  </nav>;
}

export function WorkspaceToolbarLink({ context }) {
  const navigation = useHostNavigation();
  if (!context?.companyId) return null;
  return <a {...navigation.linkProps('/company-operations')} className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">PolyForge</a>;
}
