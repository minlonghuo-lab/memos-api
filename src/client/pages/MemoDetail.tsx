import { useParams } from "react-router-dom";
import MemoDetailContent from "@/components/MemoDetailContent";

const MemoDetail = () => {
  const params = useParams();
  const memoId = Number(params.memoId);
  return <MemoDetailContent memoId={memoId} mode="page" />;
};

export default MemoDetail;
