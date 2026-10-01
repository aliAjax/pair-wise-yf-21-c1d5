import "./styles.css";
import CarpetDetail from "./components/CarpetDetail";
import CarpetList from "./components/CarpetList";
import ColorCards from "./components/ColorCards";
import LogPanel from "./components/LogPanel";
import RevisionLedger from "./components/RevisionLedger";
import StatusBar from "./components/StatusBar";
import SyncQueue from "./components/SyncQueue";
import { StoreProvider } from "./store";

function App() {
  return (
    <StoreProvider>
      <main className="app">
        <section className="hero">
          <p>hxyfront-62009 · 手工地毯修复工作室 · Port 62009</p>
          <h1>地毯修复 · 续作修订账</h1>
          <span>
            库房断网时在平板补录破损区域、补线色卡与工序，回网后按<strong>地毯编号 + 字段</strong>并回总档；
            同一字段两边都改则<strong>留两版待人工确认，后写不再覆盖</strong>；
            色卡过期或范围调整，<strong>关联工序与修复前后记录立即作废重算，失效色卡上的工序禁止完工</strong>；
            上传失败<strong>留住已完成部分、只补未完成项</strong>，重复提交经 opId 幂等去重，不生成第二份记录。
          </span>
        </section>

        <StatusBar />

        <div className="layout-grid">
          <div className="col-left">
            <CarpetList />
            <ColorCards />
          </div>
          <div className="col-right">
            <CarpetDetail />
          </div>
        </div>

        <div className="bottom-grid">
          <RevisionLedger />
          <SyncQueue />
          <LogPanel />
        </div>
      </main>
    </StoreProvider>
  );
}

export default App;
