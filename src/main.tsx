import { render } from 'preact';
import './ui/styles.css';
import { App } from './ui/App.tsx';

render(<App />, document.getElementById('ui')!);
