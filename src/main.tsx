import { createRoot } from 'react-dom/client';
import App from './App';
import { fontFaces } from './typography';
import './styles.css';

const fonts = document.createElement('style');
fonts.textContent = fontFaces;
document.head.append(fonts);

createRoot(document.getElementById('root')!).render(<App />);
