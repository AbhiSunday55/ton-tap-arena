import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Trash2 } from "lucide-react";
import { trpc } from "@/_core/trpc";
import { useAuth } from "@/_core/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Example authenticated page: owner-scoped CRUD over `items`. Shows the
// end-to-end pattern (protected route → protectedProcedure → owner-scoped query).
export default function Dashboard() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const items = trpc.items.list.useQuery();
  const create = trpc.items.create.useMutation({ onSuccess: () => utils.items.list.invalidate() });
  const remove = trpc.items.remove.useMutation({ onSuccess: () => utils.items.list.invalidate() });
  const [title, setTitle] = useState("");

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) return;
    await create.mutateAsync({ title: title.trim() });
    setTitle("");
  }

  async function onLogout() {
    await logout();
    navigate("/");
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Signed in as {user?.email}</p>
        </div>
        <Button variant="outline" onClick={onLogout}>
          Log out
        </Button>
      </header>

      <form onSubmit={onAdd} className="flex gap-2">
        <Input placeholder="New item title…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" disabled={create.isPending}>
          Add
        </Button>
      </form>

      <div className="space-y-3">
        {items.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {items.data?.length === 0 && <p className="text-muted-foreground">No items yet.</p>}
        {items.data?.map((item) => (
          <Card key={item.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0 py-4">
              <CardTitle className="text-base">{item.title}</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove.mutate({ id: item.id })}
                aria-label="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </CardHeader>
            {item.notes && <CardContent className="pt-0 text-sm text-muted-foreground">{item.notes}</CardContent>}
          </Card>
        ))}
      </div>
    </main>
  );
}
