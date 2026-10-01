import type { ReactNode } from "react";
import { Route, Switch, Redirect } from "wouter";
import { useAuth } from "./_core/useAuth";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Dashboard from "./pages/Dashboard";

// Route guard: redirect anonymous users to /login. Depends only on useAuth —
// never on the session mechanism.
function Protected({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!user) return <Redirect to="/login" />;
  return <>{children}</>;
}

// Agent wires business routes here (wouter).
export default function App() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/dashboard">
        <Protected>
          <Dashboard />
        </Protected>
      </Route>
      <Route>{() => <div className="p-8">Not found</div>}</Route>
    </Switch>
  );
}
