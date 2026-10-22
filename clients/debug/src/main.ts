import "./styles.css";
import { App } from "./app";

const app = new App();
app.start();
// handle for debugging in the browser console and for the e2e test
(window as unknown as { mrs6000: App }).mrs6000 = app;
