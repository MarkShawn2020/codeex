import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import styles from './styles.css?inline';

const root = document.querySelector<HTMLDivElement>('#root');
if (!root) throw new Error('Codeex plugin center root is missing.');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 2, staleTime: 1_000 } },
});
const style = document.createElement('style');
style.textContent = styles;
document.head.append(style);
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
