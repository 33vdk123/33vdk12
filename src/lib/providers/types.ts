// واجهة المزودات الموحدة — كل مزود ينفذ هذا العقد
export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد معرف المهمة لدى المزود
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<CreateTaskResult>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}
