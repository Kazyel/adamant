import { createRoot } from 'react-dom/client';
import App from './app/App';
import { fontFaces } from './shared/styles/typography';
import './app/styles.css';

const fonts = document.createElement('style');
fonts.textContent = fontFaces;
document.head.append(fonts);

createRoot(document.getElementById('root')!).render(<App />);
