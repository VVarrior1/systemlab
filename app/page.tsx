import { redirect } from "next/navigation";
import { lessons } from "@/lib/curriculum";
export default function Home() { redirect(`/learn/${lessons[0].id}`); }
