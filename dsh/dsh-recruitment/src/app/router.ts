export type AppRoute =
  | { kind: 'queue' }
  | { kind: 'jobs' }
  | { kind: 'talent' }
  | { kind: 'application'; applicationId: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'interviewer' };

export function parseHashRoute(hash: string): AppRoute {
  const cleaned = hash.replace(/^#/, '').trim();
  if (!cleaned || cleaned === '/' || cleaned === '/queue') {
    return { kind: 'queue' };
  }
  if (cleaned === '/jobs') {
    return { kind: 'jobs' };
  }
  if (cleaned === '/talent') {
    return { kind: 'talent' };
  }
  if (cleaned === '/interviewer') {
    return { kind: 'interviewer' };
  }
  const appMatch = cleaned.match(/^\/application\/([^/?#]+)/);
  if (appMatch && appMatch[1]) {
    return { kind: 'application', applicationId: decodeURIComponent(appMatch[1]) };
  }
  const jobMatch = cleaned.match(/^\/job\/([^/?#]+)/);
  if (jobMatch && jobMatch[1]) {
    return { kind: 'job', jobId: decodeURIComponent(jobMatch[1]) };
  }
  return { kind: 'queue' };
}

export function formatHashRoute(route: AppRoute): string {
  switch (route.kind) {
    case 'queue':
      return '#/queue';
    case 'jobs':
      return '#/jobs';
    case 'talent':
      return '#/talent';
    case 'interviewer':
      return '#/interviewer';
    case 'application':
      return `#/application/${encodeURIComponent(route.applicationId)}`;
    case 'job':
      return `#/job/${encodeURIComponent(route.jobId)}`;
  }
}

export function navigateToRoute(route: AppRoute, replace = false): void {
  const nextHash = formatHashRoute(route);
  const basePath = window.location.pathname + window.location.search;
  if (replace) {
    window.history.replaceState(null, '', `${basePath}${nextHash}`);
  } else {
    window.history.pushState(null, '', `${basePath}${nextHash}`);
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
